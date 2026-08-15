-- Bound the input to to_tsvector so the generated column can never exceed
-- Postgres's ~1,048,575-byte tsvector limit. MAX_NOTE_CONTENT_CHARS allows
-- 10M characters; the live vault already has a note at 1,525,118 chars.
-- 200k characters is well under the byte cap even with zero lexeme
-- reuse across the two configs. Long notes lose their full-text tail —
-- semantic search still covers the rest via chunked embeddings
-- (lib/chunking.ts).
alter table notes drop column search_vector;
alter table notes add column search_vector tsvector
  generated always as (
    to_tsvector('russian', left(coalesce(title,'') || ' ' || coalesce(content,''), 200000)) ||
    to_tsvector('english', left(coalesce(title,'') || ' ' || coalesce(content,''), 200000))
  ) stored;
create index if not exists notes_search_vector_gin on notes using gin (search_vector);
