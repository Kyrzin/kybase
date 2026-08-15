-- 019: match_chunks lost its deleted_at filter.
--
-- Migration 011 (soft delete) added `and n.deleted_at is null` to
-- match_chunks so a trashed note's chunks stop surfacing in semantic
-- search. Migration 017 (top-k chunks per note) rewrote the function body
-- around row_number()/rn <= 2 and dropped that condition while doing so —
-- textSearch's equivalent soft-delete filter was untouched (separate
-- function, search_notes_fts), so only the semantic arm regressed. Found
-- live 2026-08-14 by an agent calling search_notes(type: "semantic")
-- directly, not by any test — semanticSearch/hybridSearch had no coverage
-- for this (only textSearch did), now added in lib/__itest__/search.itest.ts.
--
-- note_chunks/embeddings themselves are correctly NOT deleted on soft
-- delete (restore_note relies on them still being there — see lib/trash.ts)
-- — this is a query-filter fix only, not a data cleanup. The FK's
-- `on delete cascade` (migration 002) already removes chunks for real once
-- a note is actually purged.
create or replace function match_chunks(
  query_embedding vector(768),
  match_count     int   default 10,
  min_similarity  float default 0.55
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
      row_number() over (partition by c.note_id order by c.embedding <=> query_embedding) as rn
    from note_chunks c
    join notes n on n.id = c.note_id
    where c.embedding is not null and n.deleted_at is null
  ) ranked
  where similarity >= min_similarity and rn <= 2
  order by similarity desc
  limit match_count;
$$;
