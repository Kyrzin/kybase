import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { z } from 'zod';

export async function GET() {
  try {
    const data = await query('select * from folders order by name');
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const CreateFolderSchema = z.object({
  name:      z.string().min(1).max(255),
  parent_id: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const body   = await req.json().catch(() => ({}));
  const parsed = CreateFolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  try {
    const data = await queryOne(
      'insert into folders (name, parent_id) values ($1, $2) returning *',
      [parsed.data.name, parsed.data.parent_id ?? null]
    );
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Insert failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
