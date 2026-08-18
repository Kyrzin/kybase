-- 023: unaccent turns «guillemets» into <<angle brackets>>, and Postgres's
-- parser then swallows the whole span as an XML tag.
--
-- Migration 022 started applying unaccent() to the text before it reaches
-- to_tsvector/websearch_to_tsquery, so that a query without diacritics finds
-- a word with them. It also, unintentionally, broke every Latin-script
-- quotation in the vault. unaccent's standard rules fold « » ‹ › into << >>
-- < >, and the default text-search parser classifies <...> as a `tag` token,
-- which no standard configuration indexes. Measured on a clean
-- pgvector/pgvector:pg16 (the same image docker-compose.yml runs), 2026-08-18:
--
--   to_tsvector('simple', '«gravierende Fehler»')      -> 'fehler':2 'gravierende':1
--   unaccent('«gravierende Fehler»')                   -> <<gravierende Fehler>>
--   to_tsvector('simple', '<<gravierende Fehler>>')    -> (empty)
--   ts_debug('simple', '<<gravierende Fehler>>')       -> blank | tag | blank
--
-- So the loss is not one word after the quote: the entire quoted span leaves
-- the index. Found live through MCP search_notes, where «gravierende Fehler»
-- and «geschäftsschädigend» only ever came back at the substring fallback
-- tier with confidence "weak", while their unquoted neighbours on the same
-- line matched at the 'and' tier.
--
-- Latin script only. The parser needs ASCII-ish content to recognize a tag,
-- so «сделал робастнее» survives unaccent intact — which is why the symptom
-- shows up in the German and English notes and not in the Russian ones.
--
-- Fixing this also fixes an OLDER, independent defect that has nothing to do
-- with unaccent: anything inside angle brackets was already being dropped.
-- 'Promise<void> и <div> и Array<T>' indexed as promise/array/и/… — void,
-- div and T were never findable. In a vault this full of TypeScript and n8n
-- notes that is not a corner case.
--
-- The fix strips the angle brackets AFTER unaccent rather than rewriting the
-- guillemets before it. That order matters: post-unaccent, one translate()
-- catches every character unaccent folds into an angle bracket — the two
-- pairs measured above and any others its rules cover — instead of an
-- enumeration of the quote characters this particular vault happens to use.
-- Enumerating them would be exactly the vault-tuned constant the roadmap's
-- own framing rule rejects.
--
-- Accepted trade: a genuine HTML/XML tag in a note now indexes as words
-- rather than being discarded. For a knowledge base holding code samples
-- that is an improvement (<div> becomes findable as "div"), but it IS a
-- behavior change and is written down here rather than discovered later.

-- One shared normalizer, called by both the trigger and the query function.
-- They MUST stay in step: the index side and the query side disagreeing is
-- silent — every query still runs, it just stops matching. This repository
-- has already paid for that once, when migration 021 rebuilt
-- search_notes_fts by copying the previous body and quietly reverted
-- migration 018's ts_headline fix in the process. A function both sides call
-- cannot drift that way.
--
-- STABLE, not IMMUTABLE: unaccent() depends on a dictionary that can be
-- reloaded, so it is itself only stable. That rules out using this in a
-- generated column, which is fine — migration 013's generated column was
-- already replaced by this trigger for the same reason.
create or replace function fts_normalize(t text) returns text
language sql stable as $$
  select translate(unaccent(coalesce(t, '')), '<>', '  ');
$$;

create or replace function notes_search_vector_trigger() returns trigger
language plpgsql as $$
declare
  langs text[];
  lang text;
  bounded_title text := fts_normalize(left(coalesce(new.title, ''), 200000));
  bounded_content text := fts_normalize(left(coalesce(new.content, ''), 200000));
  bounded_tags text := fts_normalize(left(coalesce(array_to_string(new.tags, ' '), ''), 200000));
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

-- Query side. Without this half, a query typed WITH guillemets (copying a
-- quoted phrase out of a note is the obvious way to search for it) still
-- collapses to an empty tsquery and returns nothing.
--
-- ts_headline deliberately keeps reading raw n.content, unchanged from 022:
-- the raw parser handles guillemets correctly on its own, so the snippet
-- stays readable with its punctuation intact. Only the matching path needs
-- normalizing.
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
  q text := fts_normalize(search_query);
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

-- Rebuild every existing vector through the new normalizer — same trick as
-- 013/016/022. Without it the fix would only apply to notes written after
-- this migration, and every quotation already in the vault would stay
-- invisible.
update notes set title = title;
