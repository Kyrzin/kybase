import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { setSetting, getEmbeddingConfig } from '@/lib/settings';
import { z } from 'zod';

const UpdateSettingsSchema = z.object({
  provider:     z.enum(['ollama', 'google', 'openai']).optional(),
  googleApiKey: z.string().min(1).optional(),
  openaiApiKey: z.string().min(1).optional(),
  ollamaModel:  z.string().min(1).optional(),
});

// Auth is middleware.ts (session cookie or master-secret bearer) — this
// route used to re-check the bearer itself too, which only re-verified the
// same secret through a second code path and went stale the moment the UI
// stopped sending it (see the session-cookie change): the browser started
// getting 401s here even though middleware had already let it through.
export async function GET() {
  const cfg = await getEmbeddingConfig();
  return NextResponse.json({
    provider: cfg.provider,
    ollamaModel: cfg.ollamaModel,
    hasGoogleKey: !!cfg.googleApiKey,
    hasOpenaiKey: !!cfg.openaiApiKey,
  });
}

export async function PUT(req: NextRequest) {
  const raw    = await req.json().catch(() => ({}));
  const parsed = UpdateSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const body = parsed.data;

  const currentCfg = await getEmbeddingConfig();
  const providerChanged = body.provider && body.provider !== currentCfg.provider;

  if (body.provider)     await setSetting('embedding_provider', body.provider);
  if (body.googleApiKey) await setSetting('google_api_key',     body.googleApiKey);
  if (body.openaiApiKey) await setSetting('openai_api_key',     body.openaiApiKey);
  if (body.ollamaModel)  await setSetting('ollama_model',       body.ollamaModel);

  // Mark all notes for reindex when provider changes
  if (providerChanged) {
    await query('update notes set embedding_pending = true');
  }

  return NextResponse.json({ ok: true, reindexTriggered: providerChanged });
}
