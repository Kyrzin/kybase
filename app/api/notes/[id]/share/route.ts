// POST /api/notes/:id/share — create a public share link for a note.
// Master-secret-protected by middleware.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createShare } from '@/lib/shares';

const CreateShareSchema = z.object({
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = CreateShareSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  try {
    const share = await createShare(id, parsed.data.expires_in_days);
    if (!share) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Public URL from the proxy headers, same convention as OAuth discovery.
    const host  = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https';
    return NextResponse.json({
      token: share.token,
      url: `${proto}://${host}/share/${share.token}`,
      expires_at: share.expires_at,
    }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Insert failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
