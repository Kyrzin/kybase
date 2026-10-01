-- 032: note history and authorship.
--
-- Agents write to notes unattended, so "what did this note say before, and
-- who changed it" needs an answer that does not depend on anyone having kept
-- a copy. Every change keeps the note's previous state, together with the
-- client that made it.
--
-- Captured by triggers rather than by each write path in the app: the
-- snapshot is written in the same transaction as the change it describes,
-- and a write path added later is covered without anyone remembering to.
-- The app only says who is writing, as transaction-local settings (the same
-- mechanism migration 020 uses for kybase.skip_content_updated_at):
--
--   kybase.actor        who the change is attributed to ('web', 'mcp:<client>', ...)
--   kybase.change_kind  overrides the recorded kind of a content change ('revert')
--
-- A write that sets no actor is recorded as 'unattributed' rather than
-- guessed at.

create table if not exists note_revisions (
  id         bigserial   primary key,
  note_id    uuid        not null references notes(id) on delete cascade,
  -- edit | rename-link | revert: the note as it was BEFORE that change (the
  -- current state is the notes row itself). create | delete | restore: an
  -- event, with the title only.
  kind       text        not null,
  title      text,
  content    text,
  folder_id  uuid,
  tags       text[],
  changed_by text        not null,
  changed_at timestamptz not null default now()
);

create index if not exists note_revisions_note_recent on note_revisions (note_id, changed_at desc, id desc);
create index if not exists note_revisions_recent      on note_revisions (changed_at desc, id desc);
-- The feed's actor filter and its list of actors.
create index if not exists note_revisions_changed_by  on note_revisions (changed_by, changed_at desc, id desc);

-- Null on notes created before this migration: their author is unknown.
alter table notes add column if not exists created_by text;

create or replace function notes_created_by_trigger() returns trigger
language plpgsql as $$
begin
  new.created_by := coalesce(nullif(current_setting('kybase.actor', true), ''), 'unattributed');
  return new;
end;
$$;

create or replace trigger notes_created_by
  before insert on notes
  for each row execute function notes_created_by_trigger();

-- The create event goes in after the insert: the row it references has to
-- exist first. It keeps no content — the first version is the next snapshot,
-- or the note itself while it has not changed.
create or replace function notes_history_create_trigger() returns trigger
language plpgsql as $$
begin
  insert into note_revisions (note_id, kind, title, changed_by, changed_at)
  values (new.id, 'create', new.title, new.created_by, clock_timestamp());
  return null;
end;
$$;

create or replace trigger notes_history_create
  after insert on notes
  for each row execute function notes_history_create_trigger();

create or replace function notes_history_trigger() returns trigger
language plpgsql as $$
declare
  actor       text := coalesce(nullif(current_setting('kybase.actor', true), ''), 'unattributed');
  change_kind text;
  last_kind   text;
  last_by     text;
  last_at     timestamptz;
  -- clock_timestamp, not now(): now() is when the transaction began, and a
  -- transaction that waited for this row's lock would then sort before the
  -- change it waited for.
  stamp       timestamptz := clock_timestamp();
begin
  if (old.title, old.content, old.folder_id, old.tags)
       is distinct from (new.title, new.content, new.folder_id, new.tags)
     -- Deleting a folder clears folder_id on its notes (on delete set null).
     -- That is the folder going away, not an edit of the note, and the
     -- folder_id a snapshot would keep points at nothing.
     and not (new.folder_id is null
              and (old.title, old.content, old.tags) is not distinct from (new.title, new.content, new.tags)
              and not exists (select 1 from folders where id = old.folder_id))
  then
    -- Set by lib/rename-links.ts while it repoints [[links]] after a rename.
    if coalesce(current_setting('kybase.skip_content_updated_at', true), '') = 'true' then
      change_kind := 'rename-link';
    else
      change_kind := coalesce(nullif(current_setting('kybase.change_kind', true), ''), 'edit');
    end if;

    -- A burst of edits by one writer is one change: an agent appending ten
    -- lines in a minute should not leave ten snapshots, and the state before
    -- the burst is already stored. Five minutes after that snapshot, the
    -- next edit starts a new one. Only edits fold together — the first edit
    -- after a create keeps the note's first version.
    if change_kind = 'edit' then
      select kind, changed_by, changed_at into last_kind, last_by, last_at
      from note_revisions
      where note_id = old.id
      order by changed_at desc, id desc
      limit 1;
    end if;

    if not (change_kind = 'edit' and found and last_kind = 'edit' and last_by = actor
            and last_at > stamp - interval '5 minutes') then
      insert into note_revisions (note_id, kind, title, content, folder_id, tags, changed_by, changed_at)
      values (old.id, change_kind, old.title, old.content, old.folder_id, old.tags, actor, stamp);
    end if;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    insert into note_revisions (note_id, kind, title, changed_by, changed_at)
    values (old.id, 'delete', new.title, actor, stamp);
  elsif old.deleted_at is not null and new.deleted_at is null then
    insert into note_revisions (note_id, kind, title, changed_by, changed_at)
    values (old.id, 'restore', new.title, actor, stamp);
  end if;

  return new;
end;
$$;

-- Same WHEN as migration 012's updated_at trigger: writes that only touch
-- the index columns (embedding, embedding_pending, links_revision, ...) never
-- reach the function at all.
create or replace trigger notes_history
  before update on notes
  for each row
  when ((old.title, old.content, old.folder_id, old.tags, old.deleted_at)
          is distinct from
        (new.title, new.content, new.folder_id, new.tags, new.deleted_at))
  execute function notes_history_trigger();
