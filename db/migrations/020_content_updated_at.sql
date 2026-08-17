-- 020: content_updated_at — "a human/agent actually edited this note",
-- separate from updated_at's "something about this row's storable state
-- changed".
--
-- Migration 012 scoped updated_at to mean "changed", not "touched" — but
-- deliberately kept renaming's backlink rewrite (update_wikilinks rewriting
-- [[Old Title]] to [[New Title]] in every OTHER note that links to the
-- renamed one) counted as a change, since content genuinely did change for
-- those rows. That's still correct for updated_at's own consumers —
-- update_note/replace_in_note's expected_updated_at guard, and the browser
-- editor's save-conflict check — which need "did the storable state move
-- at all" to protect a full-content overwrite from clobbering a concurrent
-- write (see lib/mcp-server.ts's update_note handler).
--
-- It stopped being correct once a second, narrower reader showed up:
-- list_notes(updated_after:)'s "what changed since I was last here", plus
-- lib/export.ts's frontmatter timestamp and lib/shares.ts's public "last
-- updated" display — all three want "a human/agent meaningfully edited
-- this note", not "some other note's rename mechanically swapped one link
-- string inside it". A vault where one note has 23 backlinks makes every
-- rename of that note claim 23 unrelated notes were "updated" — pure noise
-- for anyone trying to reconstruct what actually happened (2026-08-17,
-- discussed with the owner against the roadmap's earlier "Отклонено
-- сознательно" rejection of a separate column — that rejection assumed
-- updated_at's six consumers all wanted the same semantics; they split
-- into two groups with genuinely different needs, so the rejection's own
-- premise doesn't hold. restore_note was checked the same day and does not
-- touch any other note's row at all, so it needs no exemption here.
--
-- Mechanism: content_updated_at bumps under the exact same WHEN condition
-- updated_at already uses, except when a transaction-local flag says the
-- write in progress is update_wikilinks' own backlink rewrite —
-- set_config(..., true) is transaction-scoped and auto-clears at
-- commit/rollback regardless, but update_wikilinks also clears it
-- explicitly right after its own UPDATE so a later, genuine write inside
-- the same transaction (there isn't one today, but nothing should rely on
-- that staying true) is never accidentally suppressed too.
alter table notes add column if not exists content_updated_at timestamptz not null default now();
update notes set content_updated_at = updated_at;

create or replace function set_content_updated_at() returns trigger
language plpgsql as $$
begin
  new.content_updated_at = now();
  return new;
end;
$$;

create or replace trigger notes_content_updated_at
  before update on notes
  for each row
  when (
    (old.title, old.content, old.folder_id, old.tags, old.deleted_at)
      is distinct from
    (new.title, new.content, new.folder_id, new.tags, new.deleted_at)
    and coalesce(current_setting('kybase.skip_content_updated_at', true), '') <> 'true'
  )
  execute function set_content_updated_at();

create or replace function public.update_wikilinks(old_title text, new_title text)
 returns void
 language plpgsql
as $function$
declare
  escaped  text := regexp_replace(old_title, '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
  safe_new text := replace(new_title, '\', '\\');
begin
  perform set_config('kybase.skip_content_updated_at', 'true', true);
  update notes
  set content = regexp_replace(
    content,
    '\[\[' || escaped || '([#|][^\]]*)?\]\]',
    '[[' || safe_new || '\1]]',
    'gi'
  )
  where content ~* ('\[\[' || escaped || '([#|][^\]]*)?\]\]');
  perform set_config('kybase.skip_content_updated_at', 'false', true);
end;
$function$;
