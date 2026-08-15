// lib/secret-strength.ts — KYBASE_SECRET is checked for PRESENCE on every
// request (proxy.ts, lib/route-auth.ts) but never for STRENGTH — an
// internet-facing instance running on a short/default secret is one guess
// away from full access (every API route, MCP, OAuth issuance, session
// signing, and settings encryption all key off this one value). A blanket
// hard refusal to start would break existing installs that have been
// running fine on a short secret for months; the split below only refuses
// outright for a brand-new install (nothing to break yet) or an obviously
// default value (a real risk regardless of install age) — an existing
// install with a merely-short secret gets a log warning, not a crash loop.
const OBVIOUS_DEFAULTS = new Set([
  '', 'password', 'changeme', 'change-me', 'change_me', 'secret', 'admin',
  'default', 'test', 'testing', 'letmein', 'password123', 'kybase',
]);

// Not a cryptographic entropy check — just "clearly wasn't chosen on
// purpose". This value is bearer-token material AND key material (session
// signing, lib/secret-box.ts) at once, so 16 is a floor, not a target;
// generate with `openssl rand -hex 32` for real use.
const MIN_SECRET_LENGTH = 16;

export type SecretStrengthResult =
  | { verdict: 'ok' }
  | { verdict: 'reject'; reason: string }
  | { verdict: 'warn'; reason: string };

export function checkSecretStrength(secret: string | undefined, isNewInstall: boolean): SecretStrengthResult {
  const value = secret ?? '';
  const normalized = value.trim().toLowerCase();

  if (OBVIOUS_DEFAULTS.has(normalized)) {
    return {
      verdict: 'reject',
      reason: value
        ? `KYBASE_SECRET is set to an obviously default value ("${value}") — this must not ship on an internet-reachable instance. Set a real secret (e.g. \`openssl rand -hex 32\`) before starting.`
        : 'KYBASE_SECRET is not set. Set a real secret (e.g. `openssl rand -hex 32`) before starting.',
    };
  }

  if (value.length < MIN_SECRET_LENGTH) {
    const reason = `KYBASE_SECRET is only ${value.length} character${value.length === 1 ? '' : 's'} — below the recommended minimum of ${MIN_SECRET_LENGTH}. It authenticates every API request, MCP, and OAuth issuance, and doubles as key material for session signing and settings encryption. Generate a stronger one with \`openssl rand -hex 32\`.`;
    return isNewInstall
      ? { verdict: 'reject', reason: `${reason} Refusing to start a brand-new install on a weak secret.` }
      : { verdict: 'warn', reason };
  }

  return { verdict: 'ok' };
}
