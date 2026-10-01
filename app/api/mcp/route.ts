// app/api/mcp/route.ts — MCP Streamable HTTP endpoint (Web-standard transport)
// Auth handled internally (not by proxy.ts) for SSE compatibility
// Anti-buffering headers prevent Traefik/Nginx from breaking SSE streams
import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '@/lib/mcp-server';
import { bearerToken, safeEqual } from '@/lib/auth';
import { verifyToken } from '@/lib/tokens';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

async function parseSseToJson(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: !done });
  }
  const match = text.match(/^data: (.+)$/m);
  if (match) return JSON.parse(match[1]);
  throw new Error('No data line in SSE response');
}

const SSE_HEADERS: Record<string, string> = {
  'Cache-Control':     'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

// The master secret always works (UI, scripts, pre-token deployments);
// OAuth clients hold revocable tokens issued by /api/oauth/token.
// Returns who the caller is, as note history records it, or null when the
// request is not authorized.
async function callerActor(req: NextRequest): Promise<string | null> {
  const secret = process.env.KYBASE_SECRET;
  if (!secret) return null;
  const bearer = bearerToken(req);
  if (safeEqual(bearer, secret)) return 'mcp';
  const token = await verifyToken(bearer);
  if (!token) return null;
  return token.clientName ? `mcp:${token.clientName}` : 'mcp';
}

async function handle(req: NextRequest): Promise<Response> {
  // Credential before the rate-limit bucket: the global bucket is not per IP, so
  // garbage tokens must not be able to lock out a valid credential.
  const actor = await callerActor(req);
  if (actor === null) {
    const retryAfter = authLimitExceeded(req, 'bearer');
    if (retryAfter > 0) {
      return NextResponse.json(
        { error: 'Too many failed attempts' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
    recordAuthFailure(req, 'bearer');
    // RFC 9728 §5.1: point a 401 at the resource metadata, which is how a client
    // finds the authorization server (and its client registration).
    const host  = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https';
    return NextResponse.json({ error: 'Unauthorized' }, {
      status: 401,
      headers: {
        'WWW-Authenticate':
          `Bearer resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  // MCP SDK requires both application/json and text/event-stream in Accept.
  // Always force both so the SDK won't 406, then convert SSE→JSON for clients
  // that only accept application/json (e.g. Anthropic's MCP proxy).
  const accept = req.headers.get('accept') ?? '';
  const clientWantsSSE = accept.includes('text/event-stream');

  const patchedHeaders = new Headers(req.headers);
  patchedHeaders.set('accept', 'application/json, text/event-stream');
  const mcpReq = new NextRequest(req.url, { method: req.method, headers: patchedHeaders, body: req.body });

  // Stateless: a tool call lands on a fresh server that never saw the
  // client's initialize handshake, so the caller is named from its
  // credential instead.
  const server    = createMcpServer({ actor: () => actor });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const response = await transport.handleRequest(mcpReq);
  const responseContentType = response.headers.get('content-type') ?? '';

  // Convert SSE response to plain JSON for clients that don't want SSE
  if (!clientWantsSSE && responseContentType.includes('text/event-stream') && response.body) {
    const json = await parseSseToJson(response.body);
    return NextResponse.json(json, { status: response.status });
  }

  // Attach anti-buffering headers for SSE clients
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SSE_HEADERS)) headers.set(k, v);

  return new Response(response.body, { status: response.status, headers });
}

// Stateless transport doesn't support SSE GET streams — return 405 explicitly
// so Anthropic's proxy knows not to use GET and falls back to POST only.
export function GET() {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'POST, DELETE' },
  });
}

export const POST   = handle;
export const DELETE = handle;
