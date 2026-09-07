-- 029: bound the unstamped-vector exemption to a CONFIRMED generation.
--
-- Migration 028 added embedding_model to note_chunks and taught match_chunks
-- to exclude vectors from a different generation. Rows written before that
-- column existed carry NULL, and 028 let a NULL row match ANY active model —
-- so that an upgrade would not empty semantic search for a working vault.
--
-- That exemption is too wide, and it defeats the filter in exactly the case
-- the filter exists for. A vault upgrades (every chunk NULL), then switches
-- embedding model: the startup drift check marks every note pending and the
-- reindex begins, but until it finishes, every NULL chunk still answers —
-- scored against a query embedded by the NEW model, in a geometry it was
-- never comparable to. "Unknown provenance" was being read as "compatible
-- with whatever is running now", which is the opposite of what not knowing
-- means.
--
-- The provenance is not actually unknown, though: settings.last_indexed_model
-- records the model key that was active the last time this instance started,
-- and instrumentation.ts writes it AFTER runMigrationsOrDie(). So at the
-- moment this migration runs, that setting still holds the generation that
-- produced the rows being backfilled — not the one about to take over. That
-- makes this a recorded fact rather than a guess.
--
-- After the backfill, a NULL stamp means only one thing: an instance that
-- never recorded a model at all. Those rows are excluded rather than
-- exempted — an unknown generation is not a compatible one.

-- Chunks first: these are what semantic search actually reads.
update note_chunks c
   set embedding_model = s.value
  from settings s
 where s.key = 'last_indexed_model'
   and s.value is not null
   and s.value <> ''
   and c.embedding_model is null;

-- The whole-note vector too, so semantic-edges and any later generation
-- check see the same provenance the chunks now carry.
update notes n
   set embedding_model = s.value
  from settings s
 where s.key = 'last_indexed_model'
   and s.value is not null
   and s.value <> ''
   and n.embedding_model is null
   and n.embedding is not null;

-- The filter loses its "or the row is unstamped" arm. Everything else is
-- unchanged from 028.
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
      row_number() over (partition by c.note_id order by c.embedding <=> query_embedding) as rn
    from note_chunks c
    join notes n on n.id = c.note_id
    where c.embedding is not null
      and n.deleted_at is null
      and (allowed_ids is null or c.note_id = any(allowed_ids))
      and (model_filter is null or c.embedding_model = model_filter)
  ) ranked
  where similarity >= min_similarity and rn <= 2
  order by similarity desc
  limit match_count;
$$;
