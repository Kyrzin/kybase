// lib/secret-box.ts — reversible AES-256-GCM encryption keyed on KYBASE_SECRET.
//
// For values the app itself must read back in plaintext — provider API keys
// (to call Google/OpenAI) and share-link tokens (so the owner can re-copy an
// already-created link) — a one-way hash (as used for OAuth tokens,
// lib/tokens.ts) isn't an option: the app needs the original value back, not
// just proof that a presented value matches it.
//
// This closes the specific threat the roadmap names: a DB-only leak (a
// stolen backup, leaked DB credentials, a dump) that does not also expose
// KYBASE_SECRET. If KYBASE_SECRET itself leaks, the attacker already has
// root over the whole vault through every other path (login, bearer auth,
// session signing) — encrypting these columns adds no further protection in
// that scenario, same as OAuth's hash would not either.
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's standard 96-bit nonce
// Prefix, not a try/decrypt-and-catch: lets callers tell a migrated value
// apart from a pre-migration plaintext value (e.g. an API key typed in
// before this existed) without risking a false "successful" decrypt of
// data that was never ciphertext in the first place.
const PREFIX = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptWithSecret(plaintext: string, secret: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + [iv, authTag, ciphertext].map(b => b.toString('base64url')).join('.');
}

export function decryptWithSecret(encoded: string, secret: string): string {
  if (!isEncrypted(encoded)) throw new Error('Not an encrypted value');
  const [ivB64, tagB64, ctB64] = encoded.slice(PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}
