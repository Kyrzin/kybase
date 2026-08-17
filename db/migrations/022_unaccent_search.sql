-- 022: unaccent for FTS, and a regression fix for search_notes_fts.
--
-- Part 1 — fixes a regression THIS session introduced. Migration 021 (added
-- folder_id to search_notes_fts) was written by copying the function body
-- from migration 016 instead of the current one — it silently reverted
-- migration 018's fix (ts_headline using the vault's own configured
-- language, `headline_config := langs[1]`, plus filtering blank entries out
-- of fts_languages) back to a hardcoded `ts_headline('russian', ...)`.
-- Caught 2026-08-17 by reading the live function definition
-- (pg_get_functiondef) before building on top of it for unaccent below —
-- confirmed live, not assumed. This migration restores 018's logic in full
-- and keeps 021's folder_id.
--
-- Part 2 — unaccent, a genuinely new gap (found live 2026-08-17 by an
-- independent-agent test, then reproduced by hand): "Telescope" (typed
-- without the accent) does not strict-AND match a note containing
-- "Télescope" — confirmed independent of the language-stemmer gap (adding
-- 'french' to settings.fts_languages fixes stemming, e.g. détecter ↔
-- détection, but does nothing for the accent itself). Postgres's
-- language-specific stemmers do not fold diacritics on their own — that is
-- exactly what the unaccent extension is for.
--
-- Rather than a separate unaccent-wrapped text search configuration per
-- language (would need one pre-created per possible entry in the
-- free-typed settings.fts_languages, defeating the point of it being
-- free-typed), unaccent() is applied to the INPUT TEXT before it reaches
-- to_tsvector/websearch_to_tsquery, for every configured language and for
-- 'simple'. Symmetric on both sides (the trigger that builds search_vector,
-- and the query that builds tsq) is what makes an accented document match
-- an unaccented query and vice versa.
--
-- Deliberately NOT applied to the `n.content` argument of ts_headline: that
-- would strip accents from the visible excerpt text shown to the user, a
-- readability regression to fix a matching gap. ts_headline already takes
-- only one config for a query that can match via any of several
-- (migration 018's own accepted trade-off) — an accent-mismatched headline
-- occasionally not highlighting perfectly is the same class of already-
-- accepted imprecision, not a new failure mode.

create extension if not exists unaccent;

create or replace function notes_search_vector_trigger() returns trigger
language plpgsql as $$
declare
  langs text[];
  lang text;
  bounded_title text := unaccent(left(coalesce(new.title, ''), 200000));
  bounded_content text := unaccent(left(coalesce(new.content, ''), 200000));
  bounded_tags text := unaccent(left(coalesce(array_to_string(new.tags, ' '), ''), 200000));
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
      raise warning 'notes_search_vector_trigger: skipping invalid FTS config %: %', lang, sqlerrm;
    end;
  end loop;

  new.search_vector := vec;
  return new;
end;
$$;

-- Force a recompute for every existing row so already-indexed notes pick up
-- unaccent normalization too, not just ones written after this migration —
-- same trick migrations 013/016 used for their own vector-shape changes.
update notes set title = title;

create or replace function search_notes_fts(
  search_query text,
  match_count  int default 10
)
returns table (id uuid, title text, tags text[], folder_id uuid, rank real, headline text)
language plpgsql stable as $$
declare
  langs text[];
  lang text;
  headline_config regconfig;
  q text := unaccent(search_query);
  tsq tsquery := websearch_to_tsquery('simple', q);
begin
  select string_to_array(value, ',') into langs
  from settings where key = 'fts_languages';
  if langs is not null then
    select array_agg(l) into langs from unnest(langs) as l where btrim(l) <> '';
  end if;
  if langs is null or array_length(langs, 1) is null then
    langs := array['russian', 'english'];
  end if;

  begin
    headline_config := langs[1]::regconfig;
  exception when others then
    headline_config := 'simple'::regconfig;
  end;

  foreach lang in array langs loop
    begin
      tsq := tsq || websearch_to_tsquery(lang::regconfig, q);
    exception when others then
      raise warning 'search_notes_fts: skipping invalid FTS config %: %', lang, sqlerrm;
    end;
  end loop;

  return query
    select n.id, n.title, n.tags, n.folder_id,
           ts_rank(n.search_vector, tsq) as rank,
           ts_headline(headline_config, n.content, tsq,
             'MaxFragments=1, MaxWords=45, MinWords=20') as headline
    from notes n
    where n.deleted_at is null
      and n.search_vector @@ tsq
    order by rank desc
    limit match_count;
end;
$$;
