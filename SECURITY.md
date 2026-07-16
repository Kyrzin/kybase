# Security Policy

## The security model, honestly

Kybase is a **single-user** application with one root credential and
revocable per-client tokens:

- **`KYBASE_SECRET` (master secret)** — the UI login password and the
  `Authorization: Bearer` credential for the REST API and MCP endpoint.
  Anyone holding it owns the whole vault: read, write, delete, settings.
- **OAuth tokens** — the OAuth flow issues each MCP client (Claude, etc.)
  its own random token: 90-day sliding expiry, stored server-side only as
  a sha256 hash, revocable one-by-one in Settings → Connected clients.
  Tokens authenticate **only the MCP endpoint** — they cannot log into the
  UI, call the REST API, or list/revoke other tokens.

Consequences you should understand before deploying:

- There are no accounts or roles — the master secret is root. Rotate it
  (`.env`, restart) if you suspect it leaked; that invalidates nothing
  token-wise, so also revoke tokens you don't recognize.
- The browser UI keeps the master secret in `localStorage`; a successful
  XSS would expose it. The markdown renderer is hardened and test-covered
  against XSS payloads, but self-audit accordingly.

## What is implemented

- All auth comparisons are constant-time (`safeEqual`, `timingSafeEqual`);
  OAuth tokens are looked up by sha256 hash, never stored raw.
- Failed auth attempts are rate-limited on every endpoint that verifies the
  secret: 10/min per client IP plus a 30/min global bucket (spoofing
  `X-Forwarded-For` doesn't help). Successes are never counted.
- OAuth requires PKCE (S256 only); `redirect_uri` must be `https:` (or
  `http://localhost` for local MCP clients) and the consent page shows the
  redirect host and refuses to render in a frame.
- SQL is fully parameterized; input is zod-validated at every boundary.
- The container runs as a non-root user; embedding calls have 30 s timeouts.

## Deployment recommendations

1. Generate a strong secret: `openssl rand -hex 32`. Never reuse it elsewhere.
2. Put Kybase behind HTTPS (reverse proxy such as Traefik/Caddy/nginx).
   The bundled compose file publishes the app on plain HTTP for localhost use.
3. Do not expose Postgres publicly; the bundled compose keeps it on the
   internal network only. Set a non-default `POSTGRES_PASSWORD` in `.env`.
4. Back up regularly — see the Backups section of the README.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability), or contact the author via the GitHub
profile. Give a reasonable disclosure window; you'll get a response as soon
as possible. Please don't open public issues for security problems.
