-- 021: folder_id in search_notes_fts — mechanic for a per-folder weight
-- (roadmap item 11's remaining half; tag weight for text search shipped
-- 2026-08-17 in the same slot). A text-search hit doesn't currently say
-- which folder it came from at all — search_notes_fts has only ever
-- returned (id, title, tags, rank, headline). Needed so lib/search.ts's
-- textSearch can multiply a hit's rank by a per-folder weight the same way
-- it already does for tags (weightForTags) — e.g. downweighting a folder of
-- whole-book imports so their chunks don't crowd out ordinary notes, without
-- a `kind` column or a folder-name filter (per the roadmap's own framing:
-- mechanic in code, vocabulary in settings, no vault-specific constant).
--
-- CREATE OR REPLACE cannot add an output column to a RETURNS TABLE
-- function — Postgres rejects a changed OUT-parameter list — so this drops
-- the function first, same as every other migration here that changed its
-- shape (009, 013, 016, 018 all replaced it without adding a column, so
-- none needed this).
--
-- match_chunks (the semantic arm) is deliberately NOT touched: weighting
-- semantic search risks corrupting its own best/signalMargin absolute
-- noise-floor check (lib/search.ts semanticSearch) — the same finding that
-- already scoped tag weights to text search only. Folder weight gets the
-- identical text-only scope for the identical reason; adding folder_id to
-- match_chunks now, with no consumer for it, would just be an unused column
-- on a working, tested function.

drop function if exists search_notes_fts(text, int);

create function search_notes_fts(
  search_query text,
  match_count  int default 10
)
returns table (id uuid, title text, tags text[], folder_id uuid, rank real, headline text)
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
    select n.id, n.title, n.tags, n.folder_id,
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
