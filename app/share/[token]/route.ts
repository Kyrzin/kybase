// GET /share/:token — the public, anonymous, read-only view of one shared
// note. Deliberately a route handler that returns finished HTML: no client
// JS, no API access, nothing to escalate.
//
// Isolation contract (tested): exactly one database query (lib/shares.ts
// getSharedNote); the response exposes only title, content, updated_at;
// wikilinks render as dead text so nothing links to — or reveals the
// existence of — any other note. Missing, revoked, and expired tokens share
// one code path and one identical 404.
import { NextRequest, NextResponse } from 'next/server';
import { getSharedNote } from '@/lib/shares';
import { parseMarkdown, stripWikilinks } from '@/lib/markdown';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // No JS, no external resources — inline styles only.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  // Shared links are for the people they were sent to, not search engines.
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function notFound(): NextResponse {
  return new NextResponse('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body style="font-family:system-ui;background:#11111b;color:#a6adc8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><p>This link does not exist or has been revoked.</p></body></html>', {
    status: 404,
    headers: PAGE_HEADERS,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  // Tokens are 256-bit, but don't let anyone try to enumerate them anyway.
  const retryAfter = authLimitExceeded(req, 'share');
  if (retryAfter > 0) {
    return new NextResponse('Too many requests', {
      status: 429,
      headers: { 'Retry-After': String(retryAfter), 'X-Robots-Tag': 'noindex' },
    });
  }

  const { token } = await params;
  const note = await getSharedNote(token);
  if (!note) {
    recordAuthFailure(req, 'share');
    return notFound();
  }

  const body = stripWikilinks(parseMarkdown(note.content));
  const updated = new Date(note.updated_at).toISOString().slice(0, 10);

  return new NextResponse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(note.title)}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#11111b;color:#cdd6f4;font-family:system-ui,-apple-system,sans-serif;line-height:1.65}
    main{max-width:760px;margin:0 auto;padding:48px 20px}
    h1.note-title{font-size:1.8rem;margin:0 0 4px;color:#cdd6f4}
    .meta{font-size:.8rem;color:#6c7086;margin-bottom:32px}
    article h1,article h2,article h3{color:#cdd6f4;line-height:1.3}
    article a{color:#89b4fa}
    article img{max-width:100%}
    article pre{white-space:pre-wrap;word-break:break-word}
    footer{margin-top:48px;padding-top:16px;border-top:1px solid #313244;font-size:.75rem;color:#6c7086}
  </style>
</head>
<body>
  <main>
    <h1 class="note-title">${esc(note.title)}</h1>
    <div class="meta">Shared read-only · updated ${updated}</div>
    <article>${body}</article>
    <footer>Published with Kybase</footer>
  </main>
</body>
</html>`, { headers: PAGE_HEADERS });
}
