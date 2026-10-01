// scripts/smoke-test.mts — release gate: against a running compose stack
// (real image, real Postgres, real Ollama), prove the flow every install
// actually depends on — create a note over MCP, find it again, export the
// vault — end to end, nothing mocked. Run via `npm run smoke-test` once
// `docker compose up -d` reports healthy.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.KYBASE_SECRET;
if (!SECRET) throw new Error('KYBASE_SECRET must be set for the smoke test');

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (res.isError) throw new Error(`tool ${name} errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${SECRET}` } },
  });
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(transport);
  console.log('connected to MCP endpoint');

  const title = `smoke-test-${Date.now()}`;
  const created = await callTool(client, 'create_note', { title, content: 'kybase smoke test note' });
  console.log(`created note ${created.id}`);

  // type: 'text' — deliberately not semantic/hybrid, which depend on the
  // background embedding job having run by the time this checks; FTS is
  // synchronous with the insert and exercises the same MCP round-trip.
  const found = (await callTool(client, 'search_notes', { query: title, type: 'text' })) as {
    results: { id: string }[];
  };
  if (!found.results.some((hit) => hit.id === created.id)) {
    throw new Error(`created note ${created.id} not found by search_notes: ${JSON.stringify(found)}`);
  }
  console.log('found via search_notes');

  const exportRes = await fetch(`${BASE_URL}/api/export`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (!exportRes.ok) throw new Error(`GET /api/export failed: ${exportRes.status}`);
  const buf = Buffer.from(await exportRes.arrayBuffer());
  // ZIP local-file-header magic — cheap proof this is a real archive, not an
  // error page or empty body.
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`GET /api/export did not return a zip (${buf.length} bytes)`);
  }
  console.log(`exported vault (${buf.length} bytes)`);

  await client.close();
  console.log('SMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
