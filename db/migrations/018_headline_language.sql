-- 018: ts_headline uses the configured FTS language, not a hardcoded
-- 'russian'.
--
-- Migration 016 made the MATCHING config list configurable
-- (settings.fts_languages), but the excerpt was still built with
-- `ts_headline('russian', ...)` — a French or German user's snippets get
-- cropped and highlighted by Russian morphology and stopword rules
-- regardless of what they configured. ts_headline takes exactly one
-- config, not a list (unlike websearch_to_tsquery, which this function
-- already OR-combines across every configured language) — using the
-- first configured language is the natural single choice, falling back to
-- 'simple' if the list is empty/malformed after all blank entries are
-- dropped (settings.fts_languages can be stored as an empty string after
-- clearing the list via PUT /api/settings; string_to_array('', ',')
-- returns {''}, one blank element, not an empty array — worth guarding
-- explicitly rather than relying on migration 016's weaker "is null" check).
--
-- The chosen language is validated once (cast to regconfig in a plain
-- assignment, not inside the per-row query) before use, falling back to
-- 'simple' on an invalid name — same defensive posture as the tsq-building
-- loop below it, so a typo'd first entry in fts_languages can't break
-- every text search result's excerpt.
create or replace function search_notes_fts(
  search_query text,
  match_count  int default 10
)
returns table (id uuid, title text, tags text[], rank real, headline text)
language plpgsql stable as $$
declare
  langs text[];
  lang text;
  headline_config regconfig;
  tsq tsquery := websearch_to_tsquery('simple', search_query);
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
      tsq := tsq || websearch_to_tsquery(lang::regconfig, search_query);
    exception when others then
      raise warning 'search_notes_fts: skipping invalid FTS config %: %', lang, sqlerrm;
    end;
  end loop;

  return query
    select n.id, n.title, n.tags,
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
