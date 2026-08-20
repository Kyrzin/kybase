import { NextRequest, NextResponse } from 'next/server';
import { universalSearch, type SearchMode, type SearchFilters } from '@/lib/search';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ error: 'Missing ?q= parameter' }, { status: 400 });

  const rawType = searchParams.get('type') ?? searchParams.get('mode') ?? 'hybrid';
  const mode: SearchMode = rawType === 'text' || rawType === 'semantic' ? rawType : 'hybrid';

  const rawLimit = parseInt(searchParams.get('limit') ?? '10', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 10;

  const rawOffset = parseInt(searchParams.get('offset') ?? '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const explain = searchParams.get('explain') === 'true';

  const folderId = searchParams.get('folder_id') ?? searchParams.get('folderId') ?? undefined;
  const tag = searchParams.get('tag') ?? undefined;
  const createdAfter = searchParams.get('created_after') ?? searchParams.get('createdAfter') ?? undefined;
  const createdBefore = searchParams.get('created_before') ?? searchParams.get('createdBefore') ?? undefined;
  const updatedAfter = searchParams.get('updated_after') ?? searchParams.get('updatedAfter') ?? undefined;
  const updatedBefore = searchParams.get('updated_before') ?? searchParams.get('updatedBefore') ?? undefined;

  const filters: SearchFilters | undefined =
    folderId || tag || createdAfter || createdBefore || updatedAfter || updatedBefore
      ? { folderId, tag, createdAfter, createdBefore, updatedAfter, updatedBefore }
      : undefined;

  try {
    const results = await universalSearch(q, {
      mode,
      limit,
      offset,
      filters,
      explain,
    });
    return NextResponse.json(results);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
