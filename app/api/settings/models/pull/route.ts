import { NextRequest, NextResponse } from 'next/server';
import { startModelPull, getPullProgress } from '@/lib/model-pull';
import { getEmbeddingConfig } from '@/lib/settings';
import { z } from 'zod';

const Body = z.object({ model: z.string().min(1).max(200) });

/**
 * Starts downloading an Ollama model and returns at once — a model is
 * hundreds of megabytes and would outlive the request. The client polls GET.
 */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  // Only Ollama downloads anything: Google and OpenAI serve their models
  // themselves, so there would be nothing to pull.
  if ((await getEmbeddingConfig()).provider !== 'ollama') {
    return NextResponse.json({ error: 'Only Ollama models are downloaded here' }, { status: 400 });
  }

  const { started, progress } = startModelPull(parsed.data.model);
  return started
    ? NextResponse.json(progress)
    : NextResponse.json({ error: 'A download is already running', progress }, { status: 409 });
}

export async function GET() {
  return NextResponse.json(getPullProgress() ?? { running: false });
}
