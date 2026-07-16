// DELETE /api/oauth/clients/:id — revoke one OAuth token. Master-secret-
// protected by middleware (see ../route.ts on why tokens can't do this).
import { NextRequest, NextResponse } from 'next/server';
import { revokeToken } from '@/lib/tokens';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const revoked = await revokeToken(id);
    if (!revoked) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
