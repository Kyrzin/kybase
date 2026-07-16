# Security Policy

## The security model, honestly

Kybase is a **single-user** application protected by **one shared secret**
(`KYBASE_SECRET`). That secret is simultaneously:

- the UI login password,
- the `Authorization: Bearer` token for the REST API and the MCP endpoint,
- the `access_token` issued by the OAuth flow (the `expires_in: 3600` in the
  token response is advisory — the underlying secret never expires).

Consequences you should understand before deploying:

- **Anyone holding the secret owns the whole vault** — read, write, delete,
  settings. There are no scopes, roles, or per-client tokens yet.
- **Revoking one client means rotating the secret for all clients**
  (change `KYBASE_SECRET` in `.env`, restart, re-authorize every client).
- The browser UI keeps the secret in `localStorage`; a successful XSS would
  expose it. The markdown renderer is hardened and test-covered against
  XSS payloads, but self-audit accordingly.

## What is implemented

- All auth comparisons are constant-time (`safeEqual`, `timingSafeEqual`).
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
