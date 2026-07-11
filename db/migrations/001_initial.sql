-- Kybase initial migration
-- Run once against your Supabase/PostgreSQL instance

-- Enable required extensions
create extension if not exists vector;
create extension if not exists moddatetime;

-- ─────────────────────────────────────────────
-- Folders (recursive tree)
-- ─────────────────────────────────────────────
create table if not exists folders (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references folders(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Notes with pgvector embeddings
-- ─────────────────────────────────────────────
create table if not exists notes (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  content          text not null default '',
  folder_id        uuid references folders(id) on delete set null,
  tags             text[] not null default '{}',
  embedding        vector(768),          -- nomic-embed-text & text-embedding-004 both 768-dim
  embedding_pending boolean not null default true,  -- true = needs (re)indexing
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────

-- FK index: critical for folder tree queries
create index if not exists idx_notes_folder_id on notes(folder_id);

-- HNSW index for fast cosine similarity search
create index if not exists notes_embedding_hnsw
  on notes using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Bilingual FTS (notes mix Russian + English/code terms)
create index if not exists notes_fts on notes using gin (
  (to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(content, '')) ||
   to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')))
);

-- ─────────────────────────────────────────────
-- Triggers
-- ─────────────────────────────────────────────

-- Auto-update updated_at on every UPDATE
create trigger notes_updated_at
  before update on notes
  for each row execute function moddatetime('updated_at');

-- ─────────────────────────────────────────────
-- Functions
-- ─────────────────────────────────────────────

-- Semantic search via pgvector cosine distance
create or replace function match_notes(
  query_embedding vector(768),
  match_count     int     default 10,
  min_similarity  float   default 0.3
)
returns table (id uuid, title text, content text, tags text[], similarity float)
language sql stable as $$
  select id, title, content, tags,
         1 - (embedding <=> query_embedding) as similarity
  from notes
  where embedding is not null
    and 1 - (embedding <=> query_embedding) >= min_similarity
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Case-insensitive wikilink rename
-- Handles [[Title|Alias]] and [[Title#Section|Alias]] variants
create or replace function update_wikilinks(old_title text, new_title text)
returns void language plpgsql as $$
declare
  -- Escape regex special chars in the title
  escaped text := regexp_replace(old_title, '([*+?^${}()|\[\]\\])', '\\\1', 'g');
begin
  update notes
  set content = regexp_replace(
    content,
    '\[\[' || escaped || '(\|[^\]]+)?\]\]',
    '[[' || new_title || '\1]]',
    'gi'
  )
  where content ~* ('\[\[' || escaped || '(\|[^\]]+)?\]\]');
end;
$$;
