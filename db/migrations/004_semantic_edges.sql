-- 004: semantic graph edges from note-level embeddings
--
-- Second edge source for the graph besides [[wikilinks]]: pairs of notes
-- whose whole-note embeddings (notes.embedding, maintained by indexNote)
-- are cosine-close. Computed on read — nothing is stored, so edges follow
-- every re-embedding automatically.
--
-- Pairs are deduplicated (from_id < to_id): the relation is symmetric, and
-- an undirected edge is what the graph UI draws anyway.

create or replace function semantic_edges(
  min_similarity float default 0.60,
  max_neighbors  int   default 5
)
returns table (from_id uuid, to_id uuid, similarity float)
language sql stable as $$
  select distinct
    least(a.id, nb.id)    as from_id,
    greatest(a.id, nb.id) as to_id,
    nb.similarity
  from notes a
  cross join lateral (
    select b.id, 1 - (a.embedding <=> b.embedding) as similarity
    from notes b
    where b.id <> a.id and b.embedding is not null
    order by a.embedding <=> b.embedding
    limit max_neighbors
  ) nb
  where a.embedding is not null
    and nb.similarity >= min_similarity
  order by similarity desc;
$$;
