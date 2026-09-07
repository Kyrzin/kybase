-- 030: give both search functions a deterministic order.
--
-- search_notes_fts ordered by `rank desc` and match_chunks by `similarity
-- desc`, with no tiebreak. Rows that score exactly the same came back in
-- whatever order the plan produced, which is not stable: it depends on
-- physical row order, and so changes after a dump/restore, a VACUUM FULL, an
-- index rebuild, or simply on a freshly seeded copy of the same content.
--
-- Ties are not rare here. ts_rank quantises heavily on short notes, and two
-- sibling notes of similar length that match the same single term routinely
-- score identically. The visible effect is that the same query against the
-- same vault can return a different top result on two different days with
-- nothing having changed.
--
-- It also makes the search unmeasurable. Comparing two ranking variants
-- assumes that re-running the same variant gives the same answer; it did not,
-- and a re-run of an unchanged configuration moved three of this project's
-- own evaluation queries. An A/B difference of one or two queries is exactly
-- the size of that noise, which is the size most of these differences are.
--
-- `id` carries no ranking claim of its own — it is arbitrary, and that is the
-- point: an arbitrary but FIXED order is a different thing from an
-- unspecified one. Same reasoning as substringSearch's own `order by id asc`
-- (lib/search.ts), which has had this since it was written.

create or replace function search_notes_fts(
  search_query text,
  match_count  int    default 10,
  allowed_ids  uuid[] default null
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
      and (allowed_ids is null or n.id = any(allowed_ids))
    order by rank desc, n.id
    limit match_count;
end;
$$;

drop function if exists match_chunks(vector(768), int, float, uuid[], text);
create function match_chunks(
  query_embedding vector(768),
  match_count     int      default 10,
  min_similarity  float    default 0.55,
  allowed_ids     uuid[]   default null,
  model_filter    text     default null
)
returns table (id uuid, title text, chunk_content text, heading text, tags text[], similarity float)
language sql stable as $$
  select id, title, chunk_content, heading, tags, similarity from (
    select
      c.note_id as id,
      n.title,
      c.content as chunk_content,
      c.heading,
      n.tags,
      1 - (c.embedding <=> query_embedding) as similarity,
      row_number() over (
        partition by c.note_id
        order by c.embedding <=> query_embedding, c.chunk_index
      ) as rn
    from note_chunks c
    join notes n on n.id = c.note_id
    where c.embedding is not null
      and n.deleted_at is null
      and (allowed_ids is null or c.note_id = any(allowed_ids))
      and (model_filter is null or c.embedding_model = model_filter)
  ) ranked
  where similarity >= min_similarity and rn <= 2
  order by similarity desc, id
  limit match_count;
$$;
