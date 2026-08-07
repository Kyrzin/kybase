-- 012: updated_at must mean "changed", not "touched"
--
-- notes_updated_at (001) fired on any UPDATE, with no column list. Every
-- write path that only sets index-derived columns — indexNote's `embedding
-- = ..., embedding_pending = ...` (lib/indexing.ts), and the bulk
-- `embedding_pending = true` on an embedding-provider switch
-- (app/api/settings/route.ts) — still moved updated_at, because
-- moddatetime() has no way to see that title/content/folder_id/tags/
-- deleted_at never changed.
--
-- That was harmless while updated_at was purely a UI display value. It
-- stopped being harmless the moment two things started depending on it
-- meaning "edited": expected_updated_at (optimistic locking on update_note)
-- and updated_after/updated_before (list_notes' "what changed since I was
-- last here"). A background reindex — or a provider switch across the
-- whole vault — must not trip the lock or show up as a change.
--
-- Scoped to exactly the mutable, user-facing columns: title, content,
-- folder_id, tags, deleted_at. embedding/embedding_pending are excluded on
-- purpose — that's the "touched" signal, and it already has its own field.
-- A genuine content edit (including update_wikilinks rewriting backlinks
-- after a rename) still moves updated_at, because content really did
-- change for those rows.
--
-- 'create or replace trigger' is already used in 001, so replaying this on
-- a from-scratch database (see lib/migrate.ts) is safe.
create or replace trigger notes_updated_at
  before update on notes
  for each row
  when ((old.title, old.content, old.folder_id, old.tags, old.deleted_at)
          is distinct from
        (new.title, new.content, new.folder_id, new.tags, new.deleted_at))
  execute function moddatetime('updated_at');
