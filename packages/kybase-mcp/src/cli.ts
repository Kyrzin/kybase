// packages/kybase-mcp/src/cli.ts — `npx kybase-mcp`
//
// The shebang is added by build.mjs, not written here: esbuild keeps a
// source shebang and would then emit two.
//
// The same MCP server the web app exposes at /api/mcp, as a stdio process
// with no server to run. Two modes, chosen by whether DATABASE_URL is set:
//
//   unset — an embedded Postgres (PGlite, WASM) stored under ~/.kybase.
//           Nothing to install: pgvector, unaccent and the full-text
//           configurations all come with it. This is the default.
//   set   — talk to an existing Kybase database instead. The app owns that
//           schema, so migrations are NOT run in this mode; letting a
//           package version apply migrations the running app does not know
//           about is how you break a working install.
//
// stdout carries JSON-RPC framing and nothing else. lib/migrate.ts reports
// progress on console.log, which is stdout, so console is rerouted to
// stderr before anything else runs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const note = (msg: string) => process.stderr.write(`[kybase-mcp] ${msg}\n`);

// Must happen before any library code runs — see the header.
console.log = (...args: unknown[]) => note(args.map(String).join(' '));
console.info = console.log;

function resolveDataDir(): string {
  return process.env.KYBASE_DATA_DIR || path.join(os.homedir(), '.kybase');
}

/**
 * The embedded database has no password — access is controlled by the unix
 * socket's file permissions, which is why the directory is 0700 and why
 * this never opens a TCP port. A loopback port would be reachable by every
 * other process on the machine.
 */
function ensureSecret(dir: string): string {
  const existing = process.env.KYBASE_SECRET;
  if (existing) return existing;

  const file = path.join(dir, 'secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();

  // Persisted because it encrypts embedding-provider API keys stored in
  // settings: a fresh secret every run would make yesterday's keys
  // unreadable.
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  note(`generated a new instance secret at ${file}`);
  return generated;
}

async function startEmbeddedDatabase(dir: string): Promise<() => Promise<void>> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent');
  const { moddatetime } = await import('@electric-sql/pglite/contrib/moddatetime');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  const dataDir = path.join(dir, 'pgdata');
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  // node-postgres derives the socket filename from the port, so the name is
  // fixed and the directory is what varies.
  const socket = path.join(runDir, '.s.PGSQL.5432');
  if (fs.existsSync(socket)) fs.rmSync(socket, { force: true });

  const db = await PGlite.create({ dataDir, extensions: { vector, unaccent, moddatetime } });
  const server = new PGLiteSocketServer({ db, path: socket, maxConnections: 10 });
  await server.start();

  process.env.DATABASE_URL = `postgresql:///postgres?host=${encodeURIComponent(runDir)}`;
  note(`embedded database ready at ${dataDir}`);

  return async () => {
    try { await server.stop(); } catch { /* shutting down anyway */ }
    try { await db.close(); } catch { /* shutting down anyway */ }
  };
}

async function main() {
  const external = Boolean(process.env.DATABASE_URL);
  let shutdownDatabase: () => Promise<void> = async () => {};

  if (!external) {
    const dir = resolveDataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    process.env.KYBASE_SECRET = ensureSecret(dir);
    shutdownDatabase = await startEmbeddedDatabase(dir);
  } else {
    note('using DATABASE_URL; leaving schema migrations to the app that owns it');
  }

  if (!process.env.KYBASE_MIGRATIONS_DIR) {
    process.env.KYBASE_MIGRATIONS_DIR = path.join(here, '..', 'migrations');
  }

  const { runMigrations } = await import('../../../lib/migrate');
  const { createMcpServer } = await import('../../../lib/mcp-server');

  if (!external) await runMigrations();

  if (!process.env.OLLAMA_URL && !process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY) {
    note('no embedding provider configured — full-text search works, semantic search stays idle until one is set');
  }

  await createMcpServer().connect(new StdioServerTransport());
  note('ready');

  const stop = async () => { await shutdownDatabase(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  note(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
