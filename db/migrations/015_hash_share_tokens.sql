-- 015: stop storing share tokens in plaintext
--
-- note_shares.token was the primary key, stored in plaintext — a DB dump
-- contained working public share links (roadmap item 2). Two columns
-- replace it:
--   token_hash      sha256, deterministic — what the public /share/:token
--                   route looks up by. Same pattern as oauth_tokens'
--                   token_hash (migration 007). Computable in pure SQL, so
--                   backfilled here for any share that predates this
--                   migration.
--   token_encrypted AES-256-GCM under KYBASE_SECRET (lib/secret-box.ts),
--                   written at the application layer — lets the owner's
--                   Access tab re-copy an already-created link, which a
--                   one-way hash alone can't support. SQL migrations have
--                   no access to KYBASE_SECRET, so this is left null for
--                   any pre-existing share; its "Copy" action degrades to
--                   unavailable (still revocable) until recreated. New
--                   shares always get both columns (lib/shares.ts).

alter table note_shares add column id uuid not null default gen_random_uuid();
alter table note_shares add column token_hash text;
alter table note_shares add column token_encrypted text;
update note_shares set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex');
alter table note_shares alter column token_hash set not null;
alter table note_shares drop constraint note_shares_pkey;
alter table note_shares add primary key (id);
create unique index if not exists idx_note_shares_token_hash on note_shares (token_hash);
alter table note_shares drop column token;
