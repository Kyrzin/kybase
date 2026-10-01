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
//           configurations all come with it. This is the default. One
//           process owns it; others on the same folder connect to that one.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Shutdown must finish even when a step hangs: the socket server's close
// waits for connections that arrive while it is stopping, which may be never.
async function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms).unref())]);
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

// The kernel caps a unix socket path at 108 bytes on Linux and 104 on macOS.
const SOCKET_PATH_LIMIT = 100;

// Every process sharing the database brings its own pg pool of up to 10.
const MAX_CONNECTIONS = 100;

type Address = { socket: string } | { port: number };

function databaseUrl(address: Address): string {
  // The user is spelled out: without one, node-postgres takes it from $USER,
  // which a host that starts servers with a bare environment leaves unset.
  return 'port' in address
    ? `postgresql://postgres:postgres@127.0.0.1:${address.port}/postgres`
    : `postgresql://postgres@/postgres?host=${encodeURIComponent(path.dirname(address.socket))}`;
}

function connectTo(address: Address): net.Socket {
  return 'port' in address
    ? net.connect({ host: '127.0.0.1', port: address.port })
    : net.connect({ path: address.socket });
}

async function startEmbeddedDatabase(dir: string): Promise<{ address: Address; stop: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent');
  const { moddatetime } = await import('@electric-sql/pglite/contrib/moddatetime');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  const dataDir = path.join(dir, 'pgdata');
  const db = await PGlite.create({ dataDir, extensions: { vector, unaccent, moddatetime } });

  // node-postgres derives the socket filename from the port, so the name
  // is fixed and the directory is what varies.
  const socket = path.join(dir, 'run', '.s.PGSQL.5432');
  const tooLong = Buffer.byteLength(socket) > SOCKET_PATH_LIMIT;
  if (tooLong) note(`${socket} is too long for a unix socket, so the database listens on a loopback port`);

  // KYBASE_EMBEDDED_TCP forces the loopback path on Unix too — for a data
  // directory on a filesystem that cannot host a socket (some network
  // mounts), and so this branch is testable off Windows.
  const useLoopback = process.platform === 'win32' || process.env.KYBASE_EMBEDDED_TCP === '1' || tooLong;

  let server: InstanceType<typeof PGLiteSocketServer>;
  let address: Address;
  if (useLoopback) {
    const port = await freeLoopbackPort();
    server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: MAX_CONNECTIONS });
    await server.start();
    address = { port };
  } else {
    fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    // Only the lock holder gets here, so a socket file already in place was
    // left by a process that is gone.
    if (fs.existsSync(socket)) fs.rmSync(socket, { force: true });
    server = new PGLiteSocketServer({ db, path: socket, maxConnections: MAX_CONNECTIONS });
    await server.start();
    address = { socket };
  }

  process.env.DATABASE_URL = databaseUrl(address);
  note(`embedded database ready at ${dataDir}`);

  return {
    address,
    stop: async () => {
      await atMost(server.stop(), 2_000);
      await atMost(db.close(), 5_000);
    },
  };
}

// Two processes opening one pgdata corrupt it, and PGlite's files carry no
// lock of their own. lock.json names the process that owns the folder; any
// other started on it connects to that owner's server instead, once the
// owner has written its address there.
type Lock = { pid: number; startedAt: string; socket?: string; port?: number };

const OWNER_WAIT_MS = 20_000;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseLock(text: string | null): Lock | null {
  try {
    const lock = text ? JSON.parse(text) : null;
    return lock && typeof lock.pid === 'number' ? lock : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockAddress(lock: Lock): Address | null {
  if (typeof lock.socket === 'string') return { socket: lock.socket };
  if (typeof lock.port === 'number') return { port: lock.port };
  return null;
}

// Opens the way every Postgres client does, with an SSLRequest. The owner's
// server answers with one byte; whatever else may hold the address by now,
// such as a port reused after a crash, does not.
function answers(address: Address): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connectTo(address);
    const done = (ok: boolean) => {
      probe.destroy();
      resolve(ok);
    };
    probe.setTimeout(2_000, () => done(false));
    probe.once('error', () => done(false));
    probe.once('close', () => done(false));
    probe.once('connect', () => {
      const sslRequest = Buffer.alloc(8);
      sslRequest.writeInt32BE(8, 0);
      sslRequest.writeInt32BE(80877103, 4);
      probe.write(sslRequest);
    });
    probe.once('data', (reply) => done(reply[0] === 0x4e || reply[0] === 0x53));
  });
}

/**
 * Deletes a lock left by a dead process, but only while it still holds
 * exactly the text judged stale, checked under a guard file. Without the
 * guard, two newcomers could both delete it, the second removing the fresh
 * lock the first had just taken, and both would open the database.
 */
function clearStaleLock(file: string, stale: string): void {
  const guard = `${file}.takeover`;
  let fd: number;
  try {
    fd = fs.openSync(guard, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A guard this old belongs to a process that died holding it.
    const age = Date.now() - (fs.statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age > 10_000) fs.rmSync(guard, { force: true });
    return;
  }
  try {
    if (readText(file) === stale) fs.rmSync(file, { force: true });
  } finally {
    fs.closeSync(fd);
    fs.rmSync(guard, { force: true });
  }
}

type Claim =
  | { owner: true; file: string; lock: Lock }
  | { owner: false; pid: number; address: Address };

async function claimDatabase(dir: string): Promise<Claim> {
  const file = path.join(dir, 'lock.json');
  const deadline = Date.now() + OWNER_WAIT_MS;
  for (;;) {
    const mine: Lock = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(mine));
      } finally {
        fs.closeSync(fd);
      }
      return { owner: true, file, lock: mine };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const text = readText(file);
    const lock = parseLock(text);
    let waitingFor = 'is being released';
    if (lock) {
      const address = lockAddress(lock);
      // A server answering at the published address is the owner, however its
      // pid looks from here: one in another PID namespace (a container sharing
      // this folder) can read as dead while it runs.
      if (address && (await answers(address))) return { owner: false, pid: lock.pid, address };
      if (lock.pid === process.pid || !pidAlive(lock.pid)) {
        note(`${file} was left by process ${lock.pid}, which is gone; taking over`);
        clearStaleLock(file, text as string);
      } else {
        waitingFor = address
          ? `is held by process ${lock.pid}, whose database does not answer; if no kybase-mcp is running, delete it`
          : `is held by process ${lock.pid}, which has not finished opening the database`;
      }
    } else if (text !== null) {
      // Created but never written: its process died in between.
      const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 5_000) clearStaleLock(file, text);
    }

    if (Date.now() > deadline) throw new Error(`${file} ${waitingFor}`);
    await sleep(200);
  }
}

async function publishLock(file: string, lock: Lock): Promise<void> {
  // Replaced by rename, so a reader never sees half a file. Windows refuses
  // the rename for the instant another process has the file open to read it.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
      await sleep(50);
    }
  }
}

/**
 * Keeps one idle connection to the owner's server. The owner closes it when
 * it stops and the kernel does if it dies; either way this process has lost
 * its database, and says so instead of failing every call that follows.
 */
function watchOwner(address: Address, pid: number): () => void {
  let stopped = false;
  let current: net.Socket | undefined;
  const attach = () => {
    const socket = connectTo(address);
    let connected = false;
    socket.unref();
    socket.on('connect', () => { connected = true; });
    socket.on('error', () => { /* 'close' follows and decides */ });
    socket.on('close', () => {
      if (stopped) return;
      // A connection that was up gets one reconnect before the owner is
      // declared gone.
      if (connected) {
        setTimeout(attach, 500).unref();
        return;
      }
      note(`lost the database: process ${pid}, which owned it, has stopped. Restart this server to open it again.`);
      process.exit(1);
    });
    current = socket;
  };
  attach();
  return () => {
    stopped = true;
    current?.destroy();
  };
}

type OpenDatabase = {
  role: 'owner' | 'client' | 'external';
  firstRun: boolean;
  shutdown: () => Promise<void>;
};

async function openDatabase(): Promise<OpenDatabase> {
  if (process.env.DATABASE_URL) {
    note('using DATABASE_URL; leaving schema migrations to the app that owns it');
    return { role: 'external', firstRun: false, shutdown: async () => {} };
  }

  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const claim = await claimDatabase(dir);

  if (!claim.owner) {
    process.env.KYBASE_SECRET = ensureSecret(dir).secret;
    process.env.DATABASE_URL = databaseUrl(claim.address);
    note(`the database in ${dir} is open in process ${claim.pid}; connecting to it`);
    const unwatch = watchOwner(claim.address, claim.pid);
    return { role: 'client', firstRun: false, shutdown: async () => unwatch() };
  }

  const release = () => {
    try {
      if (parseLock(readText(claim.file))?.pid === process.pid) fs.rmSync(claim.file, { force: true });
    } catch {
      // Best effort: a lock left behind is taken over by the next start.
    }
  };
  process.on('exit', release);

  const secret = ensureSecret(dir);
  process.env.KYBASE_SECRET = secret.secret;
  const database = await startEmbeddedDatabase(dir);

  if (!process.env.KYBASE_MIGRATIONS_DIR) {
    process.env.KYBASE_MIGRATIONS_DIR = path.join(here, '..', 'migrations');
  }
  const { runMigrations } = await import('../../../lib/migrate');
  await runMigrations();

  // Only now, so a process that connects never meets a half-migrated schema.
  await publishLock(claim.file, { ...claim.lock, ...database.address });

  return {
    role: 'owner',
    firstRun: secret.firstRun,
    shutdown: async () => {
      await database.stop();
      release();
    },
  };
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

  // Reindexing and trash purges run where the database lives: in its owner,
  // not in processes connected to it, and not against an app's DATABASE_URL.
  let upkeep: Promise<void> = Promise.resolve();
  if (db.role === 'owner') {
    const { startMaintenance } = await import('../../../lib/startup');
    upkeep = startMaintenance().catch((err) => {
      note(`background upkeep did not start: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  if (db.firstRun) {
    // Otherwise nobody discovers that these notes are readable at all: the
    // embedded database is not a folder of .md files, and the UI that makes
    // this a knowledge base rather than a memory blob lives elsewhere.
    note('your notes are plain Markdown — `kybase-mcp export vault.zip` writes them out as files');
    note('to read and edit them in a browser, with the graph and sharing: https://github.com/Kyrzin/kybase');
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Queries already running finish; no new connection reaches the server
    // while it stops.
    await atMost(upkeep, 3_000);
    const { getPool } = await import('../../../lib/db');
    await atMost(getPool().end(), 3_000);
    await db.shutdown();
    // Exit once whatever is already queued for stdout has been written.
    process.stdout.write('', () => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Closing stdin is how an MCP client stops a stdio server.
  process.stdin.on('end', stop);
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
