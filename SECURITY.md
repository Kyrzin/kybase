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
- The browser UI never stores the master secret client-side. Logging in
  exchanges it for a signed, httpOnly session cookie (30 days, fixed —
  no sliding refresh) that page JavaScript can never read, so an XSS
  payload can't exfiltrate it. Settings → Access → Log out clears that
  cookie for the current browser. There is no way to revoke a single
  *other* session early short of rotating the master secret, which signs
  out every browser at once, not just the one you're worried about.
  The markdown renderer is hardened against XSS payloads regardless (see
  `lib/markdown.ts`), but self-audit accordingly.

## What is implemented

- All auth comparisons are constant-time (`safeEqual`, `timingSafeEqual`);
  OAuth tokens are looked up by sha256 hash, never stored raw.
- Failed auth attempts are rate-limited on every endpoint that verifies the
  secret: 10/min per client IP plus a 30/min global bucket. The per-IP half
  trusts `X-Forwarded-For`'s first hop, so it only identifies real clients
  behind a reverse proxy you control — anyone who can reach Kybase directly
  can spoof that header and dodge it. The 30/min global bucket does not
  depend on the header at all and always applies. The credential is always
  checked before the bucket, so a valid secret or token is never blocked by
  failed attempts from someone else — the limiter only ever applies once the
  credential has already failed.
- OAuth requires PKCE (S256 only), and `redirect_uri` must match a registered
  callback URI **in full** — first against the whole-server list (claude.ai's
  connector callback by default, extend with `KYBASE_OAUTH_REDIRECT_URIS`),
  then against the specific callbacks that client registered for itself.
  Loopback addresses are the standard's own exception (RFC 8252): a local
  client listens on a random port, and the code never leaves the machine that
  started the flow.
- Client registration (RFC 7591, `/api/oauth/register`) is unauthenticated,
  because a hosted client has no credential to present before it registers.
  That does not widen anything: a registration is refused outright unless every
  callback in it already passes the server-wide list above. Registering decides
  *which* acceptable callback a client may use — never *what* is acceptable —
  so an attacker can obtain a `client_id` and still has nowhere to send a code.
  The endpoint is rate-limited like every other credential-adjacent path.
  PKCE alone doesn't stop a phishing link that supplies its own code_challenge
  and an attacker-controlled redirect_uri, and matching only the host would
  still fall to an open redirect on that host — so the whole URI is pinned,
  as OAuth 2.1 and RFC 9700 require. The consent page also shows the redirect
  host and refuses to render in a frame.
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
