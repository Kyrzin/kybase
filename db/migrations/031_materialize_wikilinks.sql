-- 031: store each [[wikilink]] occurrence instead of re-parsing every note.
--
-- Backlinks and the graph both answered "who links here" by loading note
-- CONTENT and running the link parser over it on every call — 1.2 MB of text
-- re-parsed to produce a few hundred rows that were then thrown away. The
-- cost grew with the vault, not with the answer, and a single long document
-- (a book) would have made every graph render pay for it.
--
-- What is NOT stored here, deliberately: the resolved target note id.
--
-- Which note a link points at depends on the whole title set, not on the note
-- holding the link — renaming ANY note silently changes what other notes'
-- links resolve to. Storing target ids would mean every rename has to find
-- and rewrite rows it does not own, and any missed path leaves a graph that
-- lies quietly. Resolution is a join against notes.title instead
-- (notes_title_unique_ci already indexes lower(title)), so it is always
-- current and an unresolved link is simply a join that found nothing.
--
-- Staleness is settled by content_revision (migration 028) rather than by
-- hooking every write path — create, update, append, section replace, rename
-- rewrites, import, restore. A reader recomputes only the notes whose
-- links_revision has fallen behind, so a missed write path degrades to "one
-- note re-parsed on next read", never to a wrong answer.

alter table notes add column if not exists links_revision bigint;

create table if not exists note_links (
  source_note_id uuid   not null references notes(id) on delete cascade,
  -- Position among this note's links, in document order. Part of the key so
  -- a note that links to the same target twice keeps both occurrences, each
  -- with its own surrounding text — the graph counts repeats.
  occurrence     int    not null,
  -- Inner text of [[...]] verbatim, before any splitting.
  raw            text   not null,
  -- `raw` cut at the first '#' or '|' — the ordinary target. Both forms are
  -- kept because a title may itself contain those characters, and then the
  -- whole raw string is the real target; resolution tries `raw` first for
  -- exactly that case (see extractWikilinkTarget).
  target_title   text   not null,
  -- Text around the link, captured at parse time so listing backlinks never
  -- has to load the source note's content.
  context        text,
  primary key (source_note_id, occurrence)
);

-- Resolution goes lower(target) -> lower(notes.title), in both directions:
-- "what does this link point at" and "which links point at this note".
create index if not exists note_links_target_lower on note_links (lower(target_title));
create index if not exists note_links_raw_lower    on note_links (lower(raw));
