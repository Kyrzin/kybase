-- 016: search_vector becomes a trigger, not a generated column — a
-- configurable stemmer list has to read the settings table, and generated
-- columns can only be a pure function of the row's own values (no
-- subqueries allowed). Same materialized-column read speed as migration
-- 013 (still a stored, GIN-indexed column) — only writes get slower, and
-- only by one extra settings lookup.
--
-- Per "наряд на поиск 2026-08-14" шаг 5 / the roadmap's own framing
-- ("рамка: публичный AGPL-продукт"): hardcoding russian+english (migration
-- 001/013) was itself a vault-specific constant. Default stays
-- ['russian','english'] — same behavior as before for this vault — but
-- it's now data (settings.fts_languages, comma-separated text), not code,
-- so someone running this against their own language mix can add 'german'
-- or swap it entirely without a fork.
--
-- 'simple' is always included on top of whatever's configured — it
-- doesn't stem at all, so it catches identifiers and partial-word
-- fragments ("kmv", "tsconfig") that every stemmer configuration drops,
-- taking load off the blind substring fallback (наряд-поиск step 3).
--
-- setweight: A = title, B = tags, C = markdown section headings
-- (extracted by regex — headings still appear in the body too, at D;
-- getting boosted twice is fine, not minimal but simple and correct),
-- D = body. This is what makes item #4 in the наряд's baseline
-- (`runbook` query, three notes tied on ts_rank) resolve correctly: a note
-- with "Runbook" in its actual title now outranks one that only mentions
-- it in a wikilink reference inside the body.
--
-- 200k-character bound preserved from migration 014 — this is not
-- optional, it's the guarantee that a future write (or this migration's
-- own backfill) can never hit Postgres's ~1,048,575-byte tsvector limit.
-- A bad language name in settings (typo, unregistered config) is caught
-- per-language rather than breaking every write on this table.

alter table notes drop column search_vector;
alter table notes add column search_vector tsvector;

create or replace function notes_search_vector_trigger() returns trigger
language plpgsql as $$
declare
  langs text[];
  lang text;
  bounded_title text := left(coalesce(new.title, ''), 200000);
  bounded_content text := left(coalesce(new.content, ''), 200000);
  bounded_tags text := left(coalesce(array_to_string(new.tags, ' '), ''), 200000);
  headings text;
  vec tsvector := ''::tsvector;
begin
  select string_to_array(value, ',') into langs
  from settings where key = 'fts_languages';
  if langs is null then
    langs := array['russian', 'english'];
  end if;

  select coalesce(string_agg(m[1], ' '), '') into headings
  from regexp_matches(bounded_content, '^#{1,6}[ \t]+(.+)$', 'ng') as m;

  -- 'simple' always, regardless of configured stemmers.
  vec := setweight(to_tsvector('simple', bounded_title), 'A')
      || setweight(to_tsvector('simple', bounded_tags), 'B')
      || setweight(to_tsvector('simple', headings), 'C')
      || setweight(to_tsvector('simple', bounded_content), 'D');

  foreach lang in array langs loop
    begin
      vec := vec
          || setweight(to_tsvector(lang::regconfig, bounded_title), 'A')
          || setweight(to_tsvector(lang::regconfig, bounded_tags), 'B')
          || setweight(to_tsvector(lang::regconfig, headings), 'C')
          || setweight(to_tsvector(lang::regconfig, bounded_content), 'D');
    exception when others then
      -- A typo'd/unregistered config in settings.fts_languages must not
      -- break every note write on the table — skip it, keep the rest.
      raise warning 'notes_search_vector_trigger: skipping invalid FTS config %: %', lang, sqlerrm;
    end;
  end loop;

  new.search_vector := vec;
  return new;
end;
$$;

create trigger notes_search_vector_update
  before insert or update of title, content, tags on notes
  for each row execute function notes_search_vector_trigger();

-- Force a recompute for every existing row — a plain UPDATE of a column
-- the trigger watches, not a real content change (updated_at is unaffected,
-- migration 012's trigger only reacts to actual value changes).
update notes set title = title;

create index if not exists notes_search_vector_gin on notes using gin (search_vector);

-- search_notes_fts rebuilt in plpgsql (was `language sql`) — combining a
-- variable-length, settings-driven list of tsquery configs with || needs a
-- loop, which a plain SQL function can't express. Signature (id, title,
-- tags, rank, headline) is unchanged, so lib/search.ts needs no changes at
-- all — the OR-cascade (наряд-поиск step 3) calls this same function and
-- picks up multi-language/simple matching automatically.
create or replace function search_notes_fts(
  search_query text,
  match_count  int default 10
)
returns table (id uuid, title text, tags text[], rank real, headline text)
language plpgsql stable as $$
declare
  langs text[];
  lang text;
  tsq tsquery := websearch_to_tsquery('simple', search_query);
begin
  select string_to_array(value, ',') into langs
  from settings where key = 'fts_languages';
  if langs is null then
    langs := array['russian', 'english'];
  end if;

  foreach lang in array langs loop
    begin
      tsq := tsq || websearch_to_tsquery(lang::regconfig, search_query);
    exception when others then
      raise warning 'search_notes_fts: skipping invalid FTS config %: %', lang, sqlerrm;
    end;
  end loop;

  return query
    select n.id, n.title, n.tags,
           ts_rank(n.search_vector, tsq) as rank,
           ts_headline('russian', n.content, tsq,
             'MaxFragments=1, MaxWords=45, MinWords=20') as headline
    from notes n
    where n.deleted_at is null
      and n.search_vector @@ tsq
    order by rank desc
    limit match_count;
end;
$$;
