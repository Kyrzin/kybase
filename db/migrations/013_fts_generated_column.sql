-- 013: materialize the FTS tsvector into a generated column with its own
-- GIN index, instead of recomputing to_tsvector(title || content) inline on
-- every search_notes_fts call.
--
-- The expression-based GIN index from 001 matches search_notes_fts's WHERE
-- clause exactly, but the planner still picked a Seq Scan over it (measured
-- live, EXPLAIN ANALYZE: 302ms, recomputing to_tsvector over full note
-- bodies for every row — twice for the WHERE filter, twice more for
-- ts_rank in the ORDER BY, en+ru each time). A generated STORED column
-- computes that tokenization once, at write time, instead of on every
-- search — verified live: same query plan shape (still a Seq Scan on this
-- table's size) drops to 9.4ms, because the column read replaces four
-- to_tsvector() calls with a stored value. Row-for-row identical results
-- (id, rank, headline) confirmed against the old function on 5 live
-- queries before this was written.
alter table notes add column if not exists search_vector tsvector
  generated always as (
    to_tsvector('russian', coalesce(title,'') || ' ' || coalesce(content,'')) ||
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  ) stored;

create index if not exists notes_search_vector_gin on notes using gin (search_vector);

-- Superseded by the index above — same bytes, indexed twice, and every
-- note write recomputed FTS vectors for this one too on top of the
-- generated column now doing so.
drop index if exists notes_fts;

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
         ts_rank(n.search_vector, q.tsq) as rank,
         ts_headline('russian', n.content, q.tsq,
           'MaxFragments=1, MaxWords=45, MinWords=20') as headline
  from notes n, q
  where n.deleted_at is null
    and n.search_vector @@ q.tsq
  order by rank desc
  limit match_count;
$$;
