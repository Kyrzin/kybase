-- 027: dynamic client registration (RFC 7591), needed for hosted MCP clients.
--
-- Measured live 2026-08-20: claude.ai's connector refuses this server outright
-- with "Incompatible auth server: does not support dynamic client
-- registration" — it reads the authorization-server metadata, finds no
-- registration_endpoint, and stops before the consent page is ever reached.
-- Until now a client_id was just a string the caller made up and nothing
-- persisted about it, which is also why redirect_uri could only ever be
-- checked against a server-wide list instead of against the client's own
-- registered callbacks, the way OAuth 2.1 actually specifies.
--
-- redirect_uris is the whole point of the row: registration is what makes
-- "registered redirect URI" a thing this server can compare against. Stored
-- as text[] and compared in full, never by prefix or host.
--
-- No client_secret column. The only grant a registered client can use here is
-- authorization_code with PKCE (see app/api/oauth/token/route.ts), i.e. a
-- public client — a secret it would have to ship to the user's browser is not
-- a secret, and inventing one would only suggest otherwise.
create table if not exists oauth_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- Registration is unauthenticated by necessity — a hosted client has no
-- credential to present before it has registered — so the table is a
-- write-open surface. The index supports the housekeeping that follows from
-- that: clients that registered and were never used are prunable by age.
create index if not exists idx_oauth_clients_created_at on oauth_clients (created_at);
