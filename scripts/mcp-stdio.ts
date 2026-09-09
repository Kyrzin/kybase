// scripts/mcp-stdio.ts — stdio MCP entrypoint (schema introspection, CLI clients)
//
// The HTTP route at /api/mcp is the normal way in; this exists for clients that
// only speak stdio. It must start and answer initialize + tools/list with no
// database reachable: createMcpServer() only registers tools, and getPool() is
// lazy, so a missing DATABASE_URL surfaces on the first tool CALL, not at boot.
// Keep it that way — nothing here may touch the database at module scope.
//
// stdout carries JSON-RPC framing and nothing else. Log to stderr only.
//
// No top-level await: the package is CommonJS, so tsx would refuse to compile it.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../lib/mcp-server';

createMcpServer()
  .connect(new StdioServerTransport())
  .catch((err) => {
    console.error('kybase stdio MCP failed to start:', err);
    process.exit(1);
  });
