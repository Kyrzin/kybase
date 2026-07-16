-- 008: public read-only share links
--
-- A share row grants anonymous read access to exactly one note via
-- /share/<token>. Deleting the row (or the note — cascade) revokes the
-- link; expires_at null means no expiry.

create table if not exists note_shares (
  token       text primary key,          -- crypto.randomBytes(32).toString('base64url')
  note_id     uuid not null references notes(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz                -- null = бессрочно
);

create index if not exists idx_note_shares_note_id on note_shares (note_id);
