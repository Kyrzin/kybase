-- 007: revocable OAuth access tokens
--
-- The OAuth flow used to hand every client the master secret itself
-- (access_token = KYBASE_SECRET, expires_in decorative). Now each
-- authorization issues a random token stored here BY HASH — a database
-- leak doesn't leak usable credentials. Revoking one client no longer
-- means rotating the secret for everyone.

create table if not exists oauth_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,      -- sha256 hex of the bearer token
  client_name  text,                      -- OAuth client_id, for the UI list
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists idx_oauth_tokens_expires on oauth_tokens (expires_at);
