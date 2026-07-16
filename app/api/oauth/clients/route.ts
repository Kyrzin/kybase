// GET /api/oauth/clients — active OAuth tokens ("connected clients") for the
// settings UI. Master-secret-protected by middleware; deliberately NOT
// accessible with an OAuth token — a client must not enumerate or revoke
// its peers (middleware only accepts the master secret).
import { NextResponse } from 'next/server';
import { listTokens } from '@/lib/tokens';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await listTokens());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
