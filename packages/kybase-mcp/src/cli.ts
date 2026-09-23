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
// Type-only: erased at build time, so it cannot disturb the import ordering
// the runtime imports below depend on.
import type { ExportNote, ExportFolder } from '../../../lib/export';

const here = path.dirname(fileURLToPath(import.meta.url));

const note = (msg: string) => process.stderr.write(`[kybase-mcp] ${msg}\n`);

// Must happen before any library code runs — see the header.
console.log = (...args: unknown[]) => note(args.map(String).join(' '));
console.info = console.log;

// Hosts that build the environment from a settings form — an MCPB bundle's
// user_config, a registry-driven installer — hand an optional field the user
// left blank over as an empty string, and some pass the unfilled placeholder
// through verbatim. The library reads these with `??`, so either would win
// over the default: an empty OLLAMA_URL is not "no Ollama", it is an invalid
// URL, and an empty EMBEDDING_PROVIDER is an unknown provider. Unset is what
// the user meant, so that is what the rest of the process sees.
for (const key of [
  'KYBASE_DATA_DIR', 'KYBASE_SECRET', 'DATABASE_URL', 'EMBEDDING_PROVIDER',
  'OLLAMA_URL', 'OLLAMA_MODEL', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
]) {
  const value = process.env[key];
  if (value !== undefined && (value.trim() === '' || value.includes('${user_config.'))) {
    delete process.env[key];
  }
}

function resolveDataDir(): string {
  return process.env.KYBASE_DATA_DIR || path.join(os.homedir(), '.kybase');
}

/**
 * The embedded database has no password. On Unix, access is controlled by
 * the socket file's permissions — hence the 0700 directory and no open
 * port. Windows cannot listen on a socket path at all (it fails with
 * EACCES), and node-postgres addresses Windows named pipes by a convention
 * that does not match the one it builds, so there the server binds a
 * loopback port instead. That port is reachable by other processes running
 * as the same user, which is the same exposure as a local development
 * Postgres; it is never reachable from another machine.
 */
function ensureSecret(dir: string): { secret: string; firstRun: boolean } {
  const existing = process.env.KYBASE_SECRET;
  if (existing) return { secret: existing, firstRun: false };

  const file = path.join(dir, 'secret');
  if (fs.existsSync(file)) return { secret: fs.readFileSync(file, 'utf8').trim(), firstRun: false };

  // Persisted because it encrypts embedding-provider API keys stored in
  // settings: a fresh secret every run would make yesterday's keys
  // unreadable.
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  note(`generated a new instance secret at ${file}`);
  return { secret: generated, firstRun: true };
}

/** An unused loopback port, picked by the OS rather than guessed. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('could not reserve a local port'))));
    });
  });
}

async function startEmbeddedDatabase(dir: string): Promise<() => Promise<void>> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent');
  const { moddatetime } = await import('@electric-sql/pglite/contrib/moddatetime');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  const dataDir = path.join(dir, 'pgdata');
  const db = await PGlite.create({ dataDir, extensions: { vector, unaccent, moddatetime } });

  // KYBASE_EMBEDDED_TCP forces the loopback path on Unix too — for a data
  // directory on a filesystem that cannot host a socket (some network
  // mounts), and so this branch is testable off Windows.
  const useLoopback = process.platform === 'win32' || process.env.KYBASE_EMBEDDED_TCP === '1';

  let server: InstanceType<typeof PGLiteSocketServer>;
  if (useLoopback) {
    const port = await freeLoopbackPort();
    server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 10 });
    await server.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  } else {
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    // node-postgres derives the socket filename from the port, so the name
    // is fixed and the directory is what varies.
    const socket = path.join(runDir, '.s.PGSQL.5432');
    if (fs.existsSync(socket)) fs.rmSync(socket, { force: true });
    server = new PGLiteSocketServer({ db, path: socket, maxConnections: 10 });
    await server.start();
    process.env.DATABASE_URL = `postgresql:///postgres?host=${encodeURIComponent(runDir)}`;
  }

  note(`embedded database ready at ${dataDir}`);

  return async () => {
    try { await server.stop(); } catch { /* shutting down anyway */ }
    try { await db.close(); } catch { /* shutting down anyway */ }
  };
}

type OpenDatabase = { external: boolean; firstRun: boolean; shutdown: () => Promise<void> };

async function openDatabase(): Promise<OpenDatabase> {
  const external = Boolean(process.env.DATABASE_URL);
  let shutdown: () => Promise<void> = async () => {};
  let firstRun = false;

  if (external) {
    note('using DATABASE_URL; leaving schema migrations to the app that owns it');
  } else {
    const dir = resolveDataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const secret = ensureSecret(dir);
    process.env.KYBASE_SECRET = secret.secret;
    firstRun = secret.firstRun;
    shutdown = await startEmbeddedDatabase(dir);
  }

  if (!process.env.KYBASE_MIGRATIONS_DIR) {
    process.env.KYBASE_MIGRATIONS_DIR = path.join(here, '..', 'migrations');
  }
  if (!external) {
    const { runMigrations } = await import('../../../lib/migrate');
    await runMigrations();
  }

  return { external, firstRun, shutdown };
}

/**
 * `kybase-mcp export [file.zip]` — the whole vault as Markdown with
 * frontmatter, folders as directories. The same archive the web app's
 * Import accepts, so notes written through this package are not stranded
 * in it; it is also the only way to read them as files, since the embedded
 * database is not a directory of .md you can open.
 */
async function runExport(target?: string): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.resolve(target ?? `kybase-export-${stamp}.zip`);

  const db = await openDatabase();
  try {
    const { query } = await import('../../../lib/db');
    const { buildExportTree } = await import('../../../lib/export');
    const JSZip = (await import('jszip')).default;

    // content_updated_at, not updated_at — matches the web export: a rename
    // elsewhere rewriting a [[link]] in this note must not claim the note
    // itself was edited.
    const [notes, folders] = await Promise.all([
      query<ExportNote>(
        'select title, content, folder_id, tags, created_at, content_updated_at as updated_at from notes where deleted_at is null order by title'
      ),
      query<ExportFolder>('select id, name, parent_id from folders'),
    ]);

    const zip = new JSZip();
    const files = buildExportTree(notes, folders);
    for (const file of files) zip.file(file.path, file.content);
    fs.writeFileSync(out, Buffer.from(await zip.generateAsync({ type: 'uint8array' })));

    process.stdout.write(`${files.length} notes written to ${out}\n`);
    process.stdout.write('Import it in Kybase: Settings -> Import .zip\n');

    // Close the pool before the database goes away, or its idle clients
    // report the socket dying as an error after a successful export.
    const { getPool } = await import('../../../lib/db');
    await getPool().end();
  } finally {
    await db.shutdown();
  }
}

async function serve(): Promise<void> {
  const db = await openDatabase();

  if (!process.env.OLLAMA_URL && !process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY) {
    note('no embedding provider configured — full-text search works, semantic search stays idle until one is set');
  }

  const { createMcpServer } = await import('../../../lib/mcp-server');
  await createMcpServer().connect(new StdioServerTransport());
  note('ready');

  if (db.firstRun) {
    // Otherwise nobody discovers that these notes are readable at all: the
    // embedded database is not a folder of .md files, and the UI that makes
    // this a knowledge base rather than a memory blob lives elsewhere.
    note('your notes are plain Markdown — `kybase-mcp export vault.zip` writes them out as files');
    note('to read and edit them in a browser, with the graph and sharing: https://github.com/Kyrzin/kybase');
  }

  const stop = async () => { await db.shutdown(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'export') return runExport(argument);
  if (command && command !== 'serve') {
    note(`unknown command "${command}" — usage: kybase-mcp [serve] | kybase-mcp export [file.zip]`);
    process.exit(2);
  }
  return serve();
}

main().catch((err) => {
  note(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
