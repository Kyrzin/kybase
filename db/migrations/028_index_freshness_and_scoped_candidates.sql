-- 028: index freshness (stale writes, vector generations) and scope-aware
-- candidate selection.
--
-- Three defects, one migration, because they share the same root: the
-- retrieval stage could not tell WHICH version of a note it was looking at,
-- nor WHICH slice of the vault the caller had asked about.
--
-- 1. A slow indexing job could overwrite a newer one. lib/indexing.ts held
--    pg_advisory_xact_lock(note id) around its delete-then-insert, which
--    SERIALIZES two concurrent index writes but does not ORDER them: two
--    edits in quick succession each schedule their own embed, and whichever
--    provider call returns second wins the lock second and commits last —
--    even when it embedded the OLDER text. The note then holds vectors for
--    content that is no longer there, with embedding_pending = false saying
--    it is up to date. content_revision gives the writer something to check:
--    the value it captured before embedding must still be current at commit.
--
-- 2. Vectors from two different embedding models could be compared. The
--    startup drift check (instrumentation.ts) marks every note pending when
--    the model changes, but the old vectors stay in note_chunks and keep
--    answering searches until the reindex finishes — so a query embedded by
--    the NEW model is scored against document vectors from the OLD one, in a
--    different geometry, and the resulting cosine means nothing. Stamping
--    each row with the model that produced it lets the query exclude the
--    generation it cannot compare against.
--
--    NULL means "written before this column existed" and is accepted by the
--    filter: on upgrade nothing is known about the existing rows, and
--    dropping every one of them would empty semantic search for a working
--    vault. Once a note is reindexed it carries a real stamp, and from then
--    on a model change excludes it instead of mixing it. Excluded, not
--    mixed, is the intended behavior: the text arm still answers while the
--    rebuild runs (lib/search.ts hybridSearch), which is a working search
--    with a missing arm rather than a confident wrong ranking.
--
-- 3. Filters were applied after top-K, so out-of-scope notes decided what
--    in-scope notes had to beat. match_chunks/search_notes_fts ranked and
--    truncated over the WHOLE vault, and lib/search.ts then removed the rows
--    that failed the folder/tag/date filter — meaning a strong hit in
--    another folder both consumed a candidate slot and raised the per-query
--    best score that the surviving rows were measured against. Both
--    functions now take the allowed id set and apply it before ORDER BY /
--    LIMIT.

-- ── 1. content_revision ────────────────────────────────────────────────────
alter table notes add column if not exists content_revision bigint not null default 1;

-- Bumped only for changes that invalidate an embedding: the indexed text
-- itself. Deliberately NOT tags/folder/deleted_at — those change what a note
-- matches through search_vector and the filters, not what its vectors mean,
-- and bumping on them would abort in-flight indexing jobs for no benefit
-- (the same reasoning migration 012 applied to updated_at).
create or replace function notes_content_revision_trigger() returns trigger
language plpgsql as $$
begin
  if new.title is distinct from old.title or new.content is distinct from old.content then
    new.content_revision := old.content_revision + 1;
  else
    new.content_revision := old.content_revision;
  end if;
  return new;
end;
$$;

create or replace trigger notes_content_revision
  before update on notes
  for each row execute function notes_content_revision_trigger();

-- ── 2. embedding generation ────────────────────────────────────────────────
alter table notes       add column if not exists embedding_model text;
alter table note_chunks add column if not exists embedding_model text;

-- ── 3. scope-aware candidate selection ─────────────────────────────────────
-- Both functions gain a nullable allowed-ids array. null = no scope filter,
-- which is the unfiltered call every existing caller already makes.
--
-- DROP then CREATE rather than CREATE OR REPLACE: adding a defaulted
-- parameter to an existing function makes an overload, and the previous
-- arity would then match both signatures ambiguously.
drop function if exists match_chunks(vector(768), int, float);
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
      and (model_filter is null or c.embedding_model is null or c.embedding_model = model_filter)
  ) ranked
  where similarity >= min_similarity and rn <= 2
  order by similarity desc
  limit match_count;
$$;

drop function if exists search_notes_fts(text, int);
create function search_notes_fts(
  search_query text,
  match_count  int    default 10,
  allowed_ids  uuid[] default null
)
returns table (id uuid, title text, tags text[], folder_id uuid, rank real, headline text)
language plpgsql stable as $$
declare
  langs text[];
  lang text;
  headline_config regconfig;
  q text := fts_normalize(search_query);
  tsq tsquery := websearch_to_tsquery('simple', q);
begin
  select string_to_array(value, ',') into langs
  from settings where key = 'fts_languages';
  if langs is not null then
    select array_agg(l) into langs from unnest(langs) as l where btrim(l) <> '';
  end if;
  if langs is null or array_length(langs, 1) is null then
    langs := array['russian', 'english'];
  end if;

  begin
    headline_config := langs[1]::regconfig;
  exception when others then
    headline_config := 'simple'::regconfig;
  end;

  foreach lang in array langs loop
    begin
      tsq := tsq || websearch_to_tsquery(lang::regconfig, q);
    exception when others then
      raise warning 'search_notes_fts: skipping invalid FTS config %: %', lang, sqlerrm;
    end;
  end loop;

  return query
    select n.id, n.title, n.tags, n.folder_id,
           ts_rank(n.search_vector, tsq) as rank,
           ts_headline(headline_config, n.content, tsq,
             'MaxFragments=1, MaxWords=45, MinWords=20') as headline
    from notes n
    where n.deleted_at is null
      and n.search_vector @@ tsq
      and (allowed_ids is null or n.id = any(allowed_ids))
    order by rank desc
    limit match_count;
end;
$$;
