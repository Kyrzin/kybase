-- 017: match_chunks returns up to 2 chunks per note instead of 1.
--
-- `distinct on (c.note_id)` (migration 002) collapses every note to its
-- single best-matching chunk before the results even compete against each
-- other — a 760-chunk book and a 3-chunk note each get exactly one shot at
-- the outer match_count slots. Measured live (наряд-поиск-2026-08-14): a
-- "что такое инод в файловой системе" query surfaces the Linux textbook's
-- one lucky matching chunk, with no way to tell from the result whether
-- that's the book's main content on the topic or an incidental mention.
--
-- row_number() over (partition by note_id order by similarity desc) <= 2
-- keeps the note-level cap that stops one huge book from consuming every
-- slot, while letting a note surface more than one genuinely relevant
-- passage when it has them — e.g. the inode section AND a nearby
-- filesystem-permissions section, both real content, instead of an
-- arbitrary single winner.
--
-- rrfMerge (lib/search.ts) already handles multiple same-id rows within
-- one arm's result list correctly without changes: it keeps the first
-- (best-scoring, since match_chunks still orders by similarity desc)
-- occurrence's excerpt, takes the max relevance across the duplicates, and
-- the extra RRF rank contribution from a second matching chunk is a
-- reasonable small corroboration boost, not a bug.
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
    where c.embedding is not null
  ) ranked
  where similarity >= min_similarity and rn <= 2
  order by similarity desc
  limit match_count;
$$;
