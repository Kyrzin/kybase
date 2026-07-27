-- 009_fts_single_headline.sql
-- search_notes_fts returned a headline stitched from up to two fragments
-- (MaxFragments=2) joined by " … ", so a text/hybrid excerpt often read as
-- disconnected scraps from different parts of the note. Agents reported this
-- as the "excerpt is glued from pieces" friction. Switch to a single, longer
-- cover-density window (MaxFragments=1) centered on the best match — one
-- coherent passage instead of stitched scraps. Snippet generation only:
-- no index change, no re-embedding, cosine/threshold behavior untouched.
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
  where (to_tsvector('russian', coalesce(n.title,'') || ' ' || coalesce(n.content,'')) ||
         to_tsvector('english', coalesce(n.title,'') || ' ' || coalesce(n.content,'')))
        @@ q.tsq
  order by rank desc
  limit match_count;
$$;
