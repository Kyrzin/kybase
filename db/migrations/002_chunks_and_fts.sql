-- 002: note chunking for semantic search + FTS-backed text search
--
-- Why chunks: one embedding per note breaks down on long notes — the
-- embedding model only sees the head of a 50k-char document. Chunks
-- (~2000 chars, split at markdown headings) give per-section vectors;
-- search returns the best-matching chunk per note.
--
-- Why search_notes_fts: the bilingual GIN index from 001 was unused —
-- PostgREST cannot express the indexed tsvector expression, so textSearch
-- fell back to ilike. This RPC matches the index expression exactly.

-- ─────────────────────────────────────────────
-- Chunks
-- ─────────────────────────────────────────────
create table if not exists note_chunks (
  id          uuid primary key default gen_random_uuid(),
  note_id     uuid not null references notes(id) on delete cascade,
  chunk_index int  not null,
  heading     text,                 -- nearest markdown heading, for context
  content     text not null,
  embedding   vector(768),
  created_at  timestamptz not null default now(),
  unique (note_id, chunk_index)
);

create index if not exists idx_note_chunks_note_id on note_chunks(note_id);

create index if not exists note_chunks_embedding_hnsw
  on note_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ─────────────────────────────────────────────
-- Semantic search over chunks: best chunk per note
-- ─────────────────────────────────────────────
create or replace function match_chunks(
  query_embedding vector(768),
  match_count     int   default 10,
  min_similarity  float default 0.55
)
returns table (id uuid, title text, chunk_content text, heading text, tags text[], similarity float)
language sql stable as $$
  select * from (
    select distinct on (c.note_id)
      c.note_id as id,
      n.title,
      c.content as chunk_content,
      c.heading,
      n.tags,
      1 - (c.embedding <=> query_embedding) as similarity
    from note_chunks c
    join notes n on n.id = c.note_id
    where c.embedding is not null
    order by c.note_id, c.embedding <=> query_embedding
  ) best
  where similarity >= min_similarity
  order by similarity desc
  limit match_count;
$$;

-- ─────────────────────────────────────────────
-- Full-text search with morphology (ru + en), ranked,
-- with a match-centered headline snippet (<b> markers, stripped client-side)
-- ─────────────────────────────────────────────
create or replace function search_notes_fts(
  search_query text,
  match_count  int default 10
)
returns table (id uuid, title text, tags text[], rank real, headline text)
language sql stable as $$
  with q as (
    select (websearch_to_tsquery('russian', search_query) ||
            websearch_to_tsquery('english', search_query)) as tsq
  )
  select n.id, n.title, n.tags,
         ts_rank(
           to_tsvector('russian', coalesce(n.title,'') || ' ' || coalesce(n.content,'')) ||
           to_tsvector('english', coalesce(n.title,'') || ' ' || coalesce(n.content,'')),
           q.tsq
         ) as rank,
         ts_headline('russian', n.content, q.tsq,
           'MaxFragments=2, MaxWords=25, MinWords=10, FragmentDelimiter= … ') as headline
  from notes n, q
  where (to_tsvector('russian', coalesce(n.title,'') || ' ' || coalesce(n.content,'')) ||
         to_tsvector('english', coalesce(n.title,'') || ' ' || coalesce(n.content,'')))
        @@ q.tsq
  order by rank desc
  limit match_count;
$$;
