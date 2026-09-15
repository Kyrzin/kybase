// packages/kybase-mcp/build.mjs — bundles src/cli.ts together with the lib/
// modules it reaches, and copies the migrations the package has to ship.
//
// Only first-party code is bundled. Everything in dependencies stays
// external: pg and the MCP SDK because they resolve fine on their own, and
// PGlite because it loads WASM alongside itself and does not survive being
// inlined.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const migrationsOut = path.join(here, 'migrations');
fs.rmSync(migrationsOut, { recursive: true, force: true });
fs.mkdirSync(migrationsOut, { recursive: true });

const migrationsIn = path.join(repoRoot, 'db', 'migrations');
const sql = fs.readdirSync(migrationsIn).filter((f) => f.endsWith('.sql'));
for (const file of sql) {
  fs.copyFileSync(path.join(migrationsIn, file), path.join(migrationsOut, file));
}

await build({
  entryPoints: [path.join(here, 'src', 'cli.ts')],
  outfile: path.join(here, 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

fs.chmodSync(path.join(here, 'dist', 'cli.js'), 0o755);
console.log(`bundled cli.js and ${sql.length} migrations`);
