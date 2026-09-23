// packages/kybase-mcp/build-mcpb.mjs — packs the stdio server as an MCPB
// bundle (.mcpb): the file Claude Desktop installs with one click, and the
// form Smithery publishes local servers in.
//
// A bundle carries its own node_modules — the host runs it with its own Node
// and installs nothing — so this stages a clean directory holding the built
// CLI, the migrations and production dependencies only, then hands it to the
// official packer. PGlite is WebAssembly, so one bundle serves every platform.
//
// Run `npm run build` first: dist/ and migrations/ are copied, not rebuilt.

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const stage = path.join(here, 'mcpb-staging');
const out = path.join(here, `kybase-mcp-${pkg.version}.mcpb`);

for (const required of ['dist/cli.js', 'migrations']) {
  if (!fs.existsSync(path.join(here, required))) {
    throw new Error(`${required} is missing — run \`npm run build\` first`);
  }
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
fs.cpSync(path.join(here, 'dist'), path.join(stage, 'dist'), { recursive: true });
fs.cpSync(path.join(here, 'migrations'), path.join(stage, 'migrations'), { recursive: true });
fs.copyFileSync(path.join(here, 'README.md'), path.join(stage, 'README.md'));
fs.copyFileSync(path.join(here, '..', '..', 'LICENSE'), path.join(stage, 'LICENSE'));

// The version is kept in package.json only; the manifest template carries a
// placeholder, so a release cannot ship a bundle that names another version.
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// "type": "module" is what makes Node load dist/cli.js as ESM; the rest is
// what `npm install` needs to resolve the production dependencies.
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  license: pkg.license,
  dependencies: pkg.dependencies,
}, null, 2)}\n`);

execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', { cwd: stage, stdio: 'inherit' });
execSync(`npx -y @anthropic-ai/mcpb validate "${path.join(stage, 'manifest.json')}"`, { stdio: 'inherit' });
execSync(`npx -y @anthropic-ai/mcpb pack "${stage}" "${out}"`, { stdio: 'inherit' });

// The official MCP Registry lists an .mcpb only together with its hash.
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`\n${path.basename(out)}\nsha256 ${sha256}`);
