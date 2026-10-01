-- 011: soft delete for notes
--
-- delete_note (REST DELETE /api/notes/:id and the MCP tool) was an instant,
-- irreversible hard delete with no scoping, no confirmation, and no undo.
-- Notes are also populated by an agent from external/untrusted content, so a
-- prompt-injected instruction to "clean up" could permanently destroy real
-- data with nothing to recover. deleted_at turns delete into a hide: every
-- read path (list/search/graph/shares/get_note/...) is updated to filter
-- deleted_at is null, restore_note (lib/trash.ts) clears it, and rows past
-- the retention window are purged for real (see lib/trash.ts) — at which
-- point the existing ON DELETE CASCADE on note_chunks/note_shares cleans up.
alter table notes add column if not exists deleted_at timestamptz;

-- The case-insensitive unique title index (006) used to block reusing a
-- title forever once any note — even a trashed one — had claimed it. Scoped
-- to live rows: a trashed "Meeting notes" no longer blocks creating a fresh
-- one, while two live notes still can't collide.
drop index if exists notes_title_unique_ci;
create unique index if not exists notes_title_unique_ci on notes (lower(title)) where deleted_at is null;

create index if not exists idx_notes_deleted_at on notes (deleted_at) where deleted_at is not null;

-- Trashed notes must not surface through search or the graph.
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
    where c.embedding is not null and n.deleted_at is null
    order by c.note_id, c.embedding <=> query_embedding
  ) best
  where similarity >= min_similarity
  order by similarity desc
  limit match_count;
$$;

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
           'MaxFragments=1, MaxWords=45, MinWords=20') as headline
  from notes n, q
  where n.deleted_at is null
    and (to_tsvector('russian', coalesce(n.title,'') || ' ' || coalesce(n.content,'')) ||
         to_tsvector('english', coalesce(n.title,'') || ' ' || coalesce(n.content,'')))
        @@ q.tsq
  order by rank desc
  limit match_count;
$$;

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
    where b.id <> a.id and b.embedding is not null and b.deleted_at is null
    order by a.embedding <=> b.embedding
    limit max_neighbors
  ) nb
  where a.embedding is not null
    and a.deleted_at is null
    and nb.similarity >= min_similarity
  order by similarity desc;
$$;
