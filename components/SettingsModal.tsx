'use client';

// components/SettingsModal.tsx — the Settings dialog (Embeddings + Access
// tabs), extracted from KybaseApp. Owns all settings-local state; the parent
// passes apiFetch, refresh setters for import, and a share-revoke callback so
// it can dismiss the editor's share popover if it shows a just-revoked share.
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Note, Folder } from '@/lib/types';

// Reindex now runs in the background (see /api/admin/reindex) so a long
// batch survives a slow browser/proxy — the modal polls this shape for
// live progress and, on failure, exactly which note and why.
type ReindexError = { id: string; title: string; message: string };
type ReindexProgress = {
  running: boolean;
  done: number;
  total: number;
  errors: ReindexError[];
  stoppedEarly?: string;
  cancelled?: boolean;
};

type OAuthClient = { id: string; client_name: string | null; created_at: string; last_used_at: string; expires_at: string };
// token is null for a share created before the token-hashing migration —
// its link can be revoked but not re-copied (see lib/shares.ts).
type ShareItem = { id: string; token: string | null; note_id: string; note_title: string; created_at: string; expires_at: string | null };
type TrashedNote = { id: string; title: string; folder_id: string | null; deleted_at: string };

type McpClient = 'claude-code' | 'claude-desktop' | 'cursor' | 'windsurf';
type ClientOs = 'mac' | 'windows' | 'linux';

const OS_LABEL: Record<ClientOs, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

/** The browser runs on the machine the config file has to land on. */
function detectOs(): ClientOs {
  if (typeof navigator === 'undefined') return 'mac';
  const ua = `${(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''} ${navigator.userAgent}`;
  if (/win/i.test(ua)) return 'windows';
  if (/mac|iphone|ipad/i.test(ua)) return 'mac';
  return 'linux';
}

/** One path, for the reader's own system — listing every platform's is noise. */
function clientPath(client: McpClient, os: ClientOs): string {
  const home = os === 'windows' ? '%USERPROFILE%\\' : '~/';
  switch (client) {
    case 'claude-code':
      return '.mcp.json in your project root';
    case 'claude-desktop':
      return os === 'windows'
        ? '%APPDATA%\\Claude\\claude_desktop_config.json'
        : os === 'mac'
          ? '~/Library/Application Support/Claude/claude_desktop_config.json'
          : '~/.config/Claude/claude_desktop_config.json';
    case 'cursor':
      return os === 'windows' ? `${home}.cursor\\mcp.json` : `${home}.cursor/mcp.json`;
    case 'windsurf':
      return os === 'windows'
        ? `${home}.codeium\\windsurf\\mcp_config.json`
        : `${home}.codeium/windsurf/mcp_config.json`;
  }
}

/** The address the browser reached this instance on is the one an agent needs. */
function mcpOrigin(): string {
  return typeof window === 'undefined' ? 'https://your-domain' : window.location.origin;
}

function mcpSnippet(client: McpClient): string {
  const url = `${mcpOrigin()}/api/mcp`;
  // Windsurf calls the field serverUrl and takes no type; Cursor takes the
  // url but no type. Getting either wrong fails with a bare connection error.
  const withType = client === 'claude-code' || client === 'claude-desktop';
  const inner = client === 'windsurf'
    ? `      "serverUrl": "${url}",`
    : `${withType ? '      "type": "http",\n' : ''}      "url": "${url}",`;
  return [
    '{',
    '  "mcpServers": {',
    '    "kybase": {',
    inner,
    '      "headers": {',
    '        "Authorization": "Bearer <KYBASE_SECRET>"',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

export default function SettingsModal({ apiFetch, onClose, setNotes, setFolders, onShareRevoked }: {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  onShareRevoked: (id: string) => void;
}) {
  const router = useRouter();
  const [settingsProvider, setSettingsProvider] = useState<'ollama' | 'google' | 'openai'>('ollama');
  const [settingsGoogleKey, setSettingsGoogleKey] = useState('');
  const [settingsOpenaiKey, setSettingsOpenaiKey] = useState('');
  const [settingsOllamaModel, setSettingsOllamaModel] = useState('embeddinggemma');
  const [settingsGoogleModel, setSettingsGoogleModel] = useState('');
  const [settingsOpenaiModel, setSettingsOpenaiModel] = useState('');
  // Text, not a number input: 'native' is a legal value, and an empty number
  // field is indistinguishable from a zero.
  const [settingsDim, setSettingsDim] = useState('');
  // Fetched from the provider itself — a caption cannot say which models a
  // provider still offers, and Google withdrew the one that used to be named
  // here while it was still the shipped default.
  const [modelList, setModelList] = useState<{ provider: string; models: { id: string }[]; error?: string; filtered: boolean } | null>(null);
  const [pull, setPull] = useState<{ running: boolean; model?: string; completed?: number; total?: number; status?: string; error?: string } | null>(null);
  const [settingsSaving, setSettingsSaving]   = useState(false);
  const [settingsStatus, setSettingsStatus]   = useState<string | null>(null);
  const [settingsFailed, setSettingsFailed]   = useState(false);
  const [reindexRunning, setReindexRunning]   = useState(false);
  const [reindexProgress, setReindexProgress] = useState<ReindexProgress | null>(null);
  const [stopping, setStopping]               = useState(false);
  const [importRunning, setImportRunning]     = useState(false);
  const [settingsTab, setSettingsTab]         = useState<'embeddings' | 'connect' | 'access'>('embeddings');
  const [mcpClient, setMcpClient] = useState<McpClient>('claude-code');
  const [clientOs] = useState<ClientOs>(detectOs);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ google: string; openai: string } | null>(null);
  // Which stemmers this vault uses, and which this Postgres build offers.
  const [ftsLanguages, setFtsLanguages] = useState<string[]>([]);
  /** What the server last confirmed, so a save can tell an edit from a no-op. */
  const [savedLanguages, setSavedLanguages] = useState<string[]>([]);
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);
  // null until /api/settings answers — the toggle must not flicker through a
  // guessed state, because it changes how every search behaves.
  const [rerank, setRerank] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [rerankSaving, setRerankSaving] = useState(false);
  // Text, not number: the field has to be able to be empty (= no floor), and
  // an empty number input is indistinguishable from a zero.
  const [rerankMinScore, setRerankMinScore] = useState('');
  const [oauthClients, setOauthClients]       = useState<OAuthClient[]>([]);
  const [shares, setShares]                   = useState<ShareItem[]>([]);
  const [trash, setTrash]                     = useState<TrashedNote[]>([]);
  const [trashError, setTrashError]           = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/settings').then(r => r.json()).then(data => {
      setSettingsProvider(data.provider ?? 'ollama');
      setSettingsOllamaModel(data.ollamaModel ?? 'embeddinggemma');
      setSettingsGoogleModel(data.googleModel ?? '');
      setSettingsOpenaiModel(data.openaiModel ?? '');
      setSettingsDim(data.embeddingDim ?? '');
      setSettingsStatus(null);
      setKeyStatus({ google: data.googleKeyStatus ?? 'unset', openai: data.openaiKeyStatus ?? 'unset' });
      setRerank({ available: !!data.rerankAvailable, enabled: !!data.rerankEnabled });
      setRerankMinScore(data.rerankMinScore === null || data.rerankMinScore === undefined ? '' : String(data.rerankMinScore));
      setFtsLanguages(Array.isArray(data.ftsLanguages) ? data.ftsLanguages : []);
      setSavedLanguages(Array.isArray(data.ftsLanguages) ? data.ftsLanguages : []);
      setAvailableLanguages(Array.isArray(data.availableLanguages) ? data.availableLanguages : []);
    });
    apiFetch('/api/oauth/clients')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (Array.isArray(d)) setOauthClients(d); })
      .catch(() => {});
    apiFetch('/api/shares')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (Array.isArray(d)) setShares(d); })
      .catch(() => {});
    apiFetch('/api/notes/trash')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (Array.isArray(d)) setTrash(d); })
      .catch(() => {});
  }, [apiFetch]);

  // Re-asked whenever the provider changes, because the answer is that
  // provider's catalogue — and asked again after a key is saved, since
  // without one there is nothing to ask with. Never blocks the dialog: a
  // failure leaves the field a plain text input, which is what it was before.
  // The result carries the provider it describes rather than being cleared
  // first: clearing would be a synchronous state write inside an effect, and
  // the stale-vs-loading distinction is exactly what that field already tells.
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/settings/models?provider=${settingsProvider}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!cancelled && d) setModelList({ provider: settingsProvider, models: d.models ?? [], error: d.error, filtered: !!d.filtered });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiFetch, settingsProvider]);

  // Polled, not streamed — the download outlives the request that starts it.
  useEffect(() => {
    if (!pull?.running) return;
    const id = setInterval(() => {
      apiFetch('/api/settings/models/pull')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d) return;
          setPull(d);
          if (!d.running && !d.error) {
            apiFetch(`/api/settings/models?provider=${settingsProvider}`)
              .then(r => (r.ok ? r.json() : null))
              .then(m => { if (m) setModelList({ provider: settingsProvider, models: m.models ?? [], error: m.error, filtered: !!m.filtered }); })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [apiFetch, pull?.running, settingsProvider]);

  const startPull = async (model: string) => {
    setPull({ running: true, model, status: 'starting' });
    const res = await apiFetch('/api/settings/models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).catch(() => null);
    if (!res || !res.ok) setPull({ running: false, error: 'Could not start the download.' });
  };

  // Saved on click, not on the modal's Save button: this is a switch, and a
  // switch that needs a second confirmation to take effect reads as broken.
  // Optimistic, then corrected from the server on failure.
  const toggleRerank = async (next: boolean) => {
    const prev = rerank;
    setRerank(r => (r ? { ...r, enabled: next } : r));
    setRerankSaving(true);
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rerankEnabled: next }),
    }).catch(() => null);
    setRerankSaving(false);
    if (!res || !res.ok) setRerank(prev);
  };

  /** The stored floor, back into the field — the server is the truth here. */
  const reloadRerankMinScore = async () => {
    const data = await apiFetch('/api/settings').then(r => r.json()).catch(() => null);
    if (data) setRerankMinScore(data.rerankMinScore == null ? '' : String(data.rerankMinScore));
  };

  // Blank clears the floor, and so does 0 — that is what someone types to
  // mean "no floor", and it used to hit the range check and return without
  // saving or saying anything. The field then showed 0 while the old floor
  // stayed in force, which is the worst possible answer: it cost a round of
  // live measurements that were all silently run against the previous value.
  // Anything else out of range now reverts the field instead of pretending.
  const saveRerankMinScore = async () => {
    const raw = rerankMinScore.trim();
    const parsed = Number(raw);
    const value = raw === '' || parsed === 0 ? null : parsed;
    if (value !== null && !(Number.isFinite(value) && value > 0 && value < 1)) {
      // Back to what is actually stored — blanking it here would claim the
      // floor was cleared when it was not, the same lie in the other direction.
      await reloadRerankMinScore();
      return;
    }
    setRerankSaving(true);
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rerankMinScore: value }),
    }).catch(() => null);
    setRerankSaving(false);
    if (!res || !res.ok) setRerankMinScore('');
  };

  const revokeClient = async (id: string) => {
    const res = await apiFetch(`/api/oauth/clients/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setOauthClients(prev => prev.filter(c => c.id !== id));
    }
  };

  const revokeShareLink = async (noteId: string, shareId: string) => {
    const res = await apiFetch(`/api/notes/${noteId}/share/${shareId}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setShares(prev => prev.filter(s => s.id !== shareId));
      onShareRevoked(shareId);
    }
  };

  const restoreNote = async (id: string) => {
    setTrashError(null);
    const res = await apiFetch(`/api/notes/${id}/restore`, { method: 'POST' });
    if (!res.ok) {
      // The one restore failure mode a user can actually act on is a title
      // collision (409) — silently doing nothing here left no way to tell
      // "worked" from "can't, rename the live note first" apart.
      const body = await res.json().catch(() => ({}));
      setTrashError(body.error ?? `Restore failed (HTTP ${res.status})`);
      return;
    }
    setTrash(prev => prev.filter(n => n.id !== id));
    // The restored note needs to reappear in the sidebar tree — simplest
    // correct fix is the same full refetch importVault already does below.
    apiFetch('/api/notes').then(r => r.json()).then(setNotes).catch(() => {});
  };

  const purgeNote = async (id: string, title: string) => {
    if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    setTrashError(null);
    const res = await apiFetch(`/api/notes/trash/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setTrash(prev => prev.filter(n => n.id !== id));
      return;
    }
    const body = await res.json().catch(() => ({}));
    setTrashError(body.error ?? `Delete failed (HTTP ${res.status})`);
  };

  // Permanent links first (they're the ones to worry about), then newest.
  const sortedShares = [...shares].sort((a, b) => {
    if (!a.expires_at !== !b.expires_at) return a.expires_at ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Starts a reindex (or attaches to one already running, e.g. the hourly
  // sweep) and polls it until done, updating the progress bar and error
  // list as results come in.
  const runReindex = async (mode: 'pending' | 'all') => {
    setReindexRunning(true);
    setSettingsFailed(false);
    setReindexProgress(null);
    setStopping(false);
    setSettingsStatus(mode === 'all' ? 'Reindexing all notes…' : 'Reindexing…');
    try {
      const startRes = await apiFetch(`/api/admin/reindex${mode === 'all' ? '?mode=all' : ''}`, { method: 'POST' });
      if (!startRes.ok && startRes.status !== 409) {
        const body = await startRes.json().catch(() => ({}));
        setSettingsFailed(true);
        setSettingsStatus(`Reindex failed: ${body.error ?? `HTTP ${startRes.status}`}`);
        return;
      }
      if (startRes.status === 409) setSettingsStatus('A reindex is already running — watching progress…');

      let final: ReindexProgress | null = null;
      for (;;) {
        const p: ReindexProgress = await (await apiFetch('/api/admin/reindex')).json();
        setReindexProgress(p);
        if (!p.running) { final = p; break; }
        await new Promise(r => setTimeout(r, 1000));
      }
      const failed = final.errors.length;
      setSettingsFailed(!final.cancelled && (failed > 0 || !!final.stoppedEarly));
      setSettingsStatus(
        final.cancelled ? `Stopped. Reindexed ${final.done} of ${final.total} before stopping.`
        : final.stoppedEarly ? final.stoppedEarly
        : failed === 0 ? `Done. Reindexed ${final.done} notes.`
        : `Reindexed ${final.done - failed} of ${final.total}, ${failed} failed — see below.`
      );
    } catch {
      setSettingsFailed(true);
      setSettingsStatus('Reindex failed.');
    } finally {
      setReindexRunning(false);
      setStopping(false);
    }
  };

  const stopReindex = async () => {
    setStopping(true);
    try {
      await apiFetch('/api/admin/reindex', { method: 'DELETE' });
    } catch {
      setStopping(false);
    }
  };

  const saveSettings = async () => {
    setSettingsSaving(true);
    setSettingsStatus(null);
    try {
      const body: Record<string, string | string[]> = { provider: settingsProvider, ollamaModel: settingsOllamaModel };
      // Only when it differs: a save carrying it rebuilds every search_vector.
      if (ftsLanguages.length && ftsLanguages.join(',') !== savedLanguages.join(',')) body.ftsLanguages = ftsLanguages;
      if (settingsGoogleModel) body.googleModel = settingsGoogleModel;
      if (settingsOpenaiModel) body.openaiModel = settingsOpenaiModel;
      // Only for the providers that have a width parameter at all.
      if (settingsProvider !== 'ollama' && settingsDim) body.embeddingDim = settingsDim;
      if (settingsGoogleKey) body.googleApiKey = settingsGoogleKey;
      if (settingsOpenaiKey) body.openaiApiKey = settingsOpenaiKey;
      const res = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      const data = await res.json();
      setSettingsFailed(false);
      setSavedLanguages(ftsLanguages);
      const saved = data.reindexTriggered
        ? `Saved. ${data.pendingCount ?? 0} notes marked for reindex — click "Reindex" below to run it.`
        : 'Settings saved.';
      // Only present when the new model's vector width needed attention —
      // including the case where it cannot be used at all, which would
      // otherwise read as an ordinary successful save.
      setSettingsStatus(data.dimensionNote ? `${saved} (${data.dimensionNote})` : saved);
    } catch {
      setSettingsFailed(true);
      setSettingsStatus('Failed to save.');
    } finally {
      setSettingsSaving(false);
    }
  };

  const exportVault = async () => {
    setSettingsStatus('Exporting…');
    try {
      const res = await apiFetch('/api/export');
      if (!res.ok) { setSettingsStatus('Export failed.'); return; }
      const blob = await res.blob();
      const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'kybase-export.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setSettingsStatus('Export downloaded.');
    } catch {
      setSettingsStatus('Export failed.');
    }
  };

  const importVault = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file
    if (!file) return;
    setImportRunning(true);
    setSettingsStatus('Importing…');
    try {
      const res = await apiFetch('/api/import', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/zip' },
      });
      const data = await res.json();
      if (!res.ok) { setSettingsStatus(data.error ?? 'Import failed.'); return; }
      setSettingsStatus(`Imported ${data.imported}, updated ${data.updated}, skipped ${data.skipped}. Embeddings index in the background.`);
      const [notesData, foldersData] = await Promise.all([
        apiFetch('/api/notes').then(r => r.json()),
        apiFetch('/api/folders').then(r => r.json()),
      ]);
      setNotes(notesData);
      setFolders(foldersData);
    } catch {
      setSettingsStatus('Import failed.');
    } finally {
      setImportRunning(false);
    }
  };

  return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
          <div style={{ background: 'rgba(30,30,46,0.85)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', border: '1px solid rgba(69,71,90,0.6)', borderRadius: 12, padding: 24, width: 'min(440px, calc(100vw - 32px))', boxShadow: '0 8px 48px rgba(0,0,0,0.6)', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontWeight: 600, fontSize: 15, color: '#cdd6f4' }}>Settings</span>
              <button onClick={() => onClose()} style={{ background: 'none', border: 'none', color: '#585b70', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #313244', marginBottom: 18 }}>
              {([['embeddings', 'Embeddings'], ['connect', 'Connect'], ['access', `Access (${shares.length + oauthClients.length})`]] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => setSettingsTab(tab)}
                  style={{
                    background: 'none', border: 'none', fontFamily: 'inherit', cursor: 'pointer',
                    padding: '8px 14px', fontSize: 13, fontWeight: 600,
                    color: settingsTab === tab ? '#89b4fa' : '#6c7086',
                    borderBottom: settingsTab === tab ? '2px solid #89b4fa' : '2px solid transparent',
                    marginBottom: -1,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {settingsTab === 'embeddings' && (
            <>
            {keyStatus && (keyStatus.google === 'undecryptable' || keyStatus.openai === 'undecryptable') && (
              <div style={{ fontSize: 12, color: '#f38ba8', background: 'rgba(243,139,168,0.1)', border: '1px solid rgba(243,139,168,0.3)', borderRadius: 6, padding: '8px 10px', marginBottom: 16, lineHeight: 1.5 }}>
                {[keyStatus.google === 'undecryptable' && 'Google', keyStatus.openai === 'undecryptable' && 'OpenAI'].filter(Boolean).join(' and ')} API key{keyStatus.google === 'undecryptable' && keyStatus.openai === 'undecryptable' ? 's are' : ' is'} saved but can no longer be read — usually means the server&apos;s secret was rotated after the key was saved. Re-enter it below to fix.
              </div>
            )}
            <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Provider</label>
            <select value={settingsProvider} onChange={e => setSettingsProvider(e.target.value as 'ollama' | 'google' | 'openai')} style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }}>
              <option value="ollama">Ollama — local, free</option>
              <option value="google">Google — API key, free tier</option>
              <option value="openai">OpenAI — API key</option>
            </select>


            {settingsProvider === 'google' && (
              <>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Google API Key</label>
                <input type="password" value={settingsGoogleKey} onChange={e => setSettingsGoogleKey(e.target.value)} placeholder="AIza… (leave blank to keep current)" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
                <div style={{ fontSize: 11, color: '#585b70', marginBottom: 16, lineHeight: 1.5 }}>Free tier: 1500 requests/day. Get a key: aistudio.google.com/apikey</div>
              </>
            )}

            {settingsProvider === 'openai' && (
              <>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>OpenAI API Key</label>
                <input type="password" value={settingsOpenaiKey} onChange={e => setSettingsOpenaiKey(e.target.value)} placeholder="sk-… (leave blank to keep current)" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
              </>
            )}

            {/* One field for every provider. A list when the provider could be
                asked, free text always: a model may be listed and not yet
                pulled (Ollama), or offered under a name the list does not
                carry. What actually refuses an unusable choice is the width
                check on save, not this control. */}
            <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Model</label>
            <input
              list="embedding-model-options"
              value={settingsProvider === 'ollama' ? settingsOllamaModel : settingsProvider === 'google' ? settingsGoogleModel : settingsOpenaiModel}
              onChange={e => {
                const v = e.target.value;
                if (settingsProvider === 'ollama') setSettingsOllamaModel(v);
                else if (settingsProvider === 'google') setSettingsGoogleModel(v);
                else setSettingsOpenaiModel(v);
              }}
              placeholder={settingsProvider === 'ollama' ? 'embeddinggemma' : 'model name'}
              style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }}
            />
            <datalist id="embedding-model-options">
              {(modelList?.provider === settingsProvider ? modelList.models : []).map(m => <option key={m.id} value={m.id} />)}
            </datalist>

            {settingsProvider === 'ollama' && modelList?.provider === 'ollama' && !modelList.error
              && settingsOllamaModel.trim() !== ''
              && !modelList.models.some(m => m.id === settingsOllamaModel.trim()) && !pull?.running && (
              <div style={{ marginTop: -10, marginBottom: 16 }}>
                <button
                  onClick={() => startPull(settingsOllamaModel.trim())}
                  style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '6px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
                >
                  Download {settingsOllamaModel.trim()}
                </button>
                <span style={{ fontSize: 11, color: '#585b70', marginLeft: 10 }}>
                  Ollama does not have it yet.
                </span>
              </div>
            )}

            {pull && (pull.running || pull.error) && (
              <div style={{ fontSize: 11, color: pull.error ? '#f38ba8' : '#a6adc8', background: '#11111b', border: `1px solid ${pull.error ? 'rgba(243,139,168,0.3)' : '#313244'}`, borderRadius: 6, padding: '8px 10px', marginTop: -10, marginBottom: 16, lineHeight: 1.6 }}>
                {pull.error
                  ? pull.error
                  : `Downloading ${pull.model} — ${pull.status}${
                      pull.total ? ` ${Math.round(((pull.completed ?? 0) / pull.total) * 100)}%` : ''
                    }`}
              </div>
            )}
            {/* Loud, not muted: semantic search is off until this is dealt with. */}
            {modelList?.provider === settingsProvider && modelList.error ? (
              <div style={{ fontSize: 12, color: '#f9e2af', background: 'rgba(249,226,175,0.08)', border: '1px solid rgba(249,226,175,0.3)', borderRadius: 6, padding: '10px 12px', marginBottom: 16, marginTop: -10, lineHeight: 1.6 }}>
                {modelList.error.split('`').map((part, i) => (i % 2 === 1
                  ? <code key={i} style={{ display: 'inline-block', background: '#11111b', border: '1px solid #313244', borderRadius: 4, padding: '2px 6px', margin: '3px 0', fontSize: 12, color: '#cdd6f4', userSelect: 'all' }}>{part}</code>
                  : <span key={i}>{part}</span>))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: '#585b70', marginBottom: 16, lineHeight: 1.5, marginTop: -10 }}>
                {modelList === null || modelList.provider !== settingsProvider
                  ? 'Loading the provider\u2019s models\u2026'
                  : modelList.models.length === 0
                    ? 'The provider listed no embedding models.'
                    : modelList.filtered
                      ? `${modelList.models.length} embedding models offered by this provider.`
                      : `${modelList.models.length} models installed. Ollama cannot say which of them embed \u2014 a chat model is refused on save, by width.`}
              </div>
            )}

            {settingsProvider !== 'ollama' && (
              <>
                {/* Ollama has no width parameter, so this is only shown where
                    it does something. Changing it re-embeds the vault: the
                    width is part of the model key, so the schema is retyped
                    and every note reindexed. */}
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Vector width</label>
                <input value={settingsDim} onChange={e => setSettingsDim(e.target.value)} placeholder="768" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
                <div style={{ fontSize: 11, color: '#585b70', marginBottom: 16, lineHeight: 1.5, marginTop: -10 }}>
                  How many numbers to ask this provider for. <code>native</code> sends no size and takes the model&apos;s own — which some older models require. Changing it re-embeds every note, and anything above 2000 is refused: pgvector cannot index it.
                </div>
              </>
            )}

            {rerank?.available && (
              <div style={{ background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px', marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: rerankSaving ? 'wait' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={rerank.enabled}
                    disabled={rerankSaving}
                    onChange={e => toggleRerank(e.target.checked)}
                    style={{ width: 15, height: 15, accentColor: '#89b4fa', cursor: 'inherit', flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 13, color: '#cdd6f4' }}>Rerank search results</span>
                </label>
                <div style={{ fontSize: 11, color: '#6c7086', marginTop: 6, lineHeight: 1.5 }}>
                  Reorders results the search already found — it cannot surface a note search
                  missed. Costs seconds per search on CPU, and applies to agents and the API, not
                  just this window.
                </div>
                {rerank.enabled && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #313244' }}>
                    <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>
                      Minimum score (optional)
                    </label>
                    <input
                      value={rerankMinScore}
                      onChange={e => setRerankMinScore(e.target.value)}
                      onBlur={saveRerankMinScore}
                      placeholder="empty or 0 = keep every result"
                      inputMode="decimal"
                      style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
                    />
                    <div style={{ fontSize: 11, color: '#6c7086', marginTop: 6, lineHeight: 1.5 }}>
                      Hits scoring below this are dropped: a question your notes cannot answer
                      comes back empty instead of the nearest unrelated thing. Leave it empty to
                      keep every result.
                    </div>
                  </div>
                )}
              </div>
            )}

            {rerank && !rerank.available && (
              <div style={{ fontSize: 11, color: '#585b70', background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: '8px 10px', marginBottom: 16, lineHeight: 1.6 }}>
                {/* Muted: an optional extra, not a broken install. */}
                A cross-encoder can reorder results after search has found them. It is not in the
                default install — another ~1 GB image, and seconds per search on CPU. Start it
                with{' '}
                <code style={{ background: '#1e1e2e', border: '1px solid #313244', borderRadius: 4, padding: '1px 5px', color: '#a6adc8', userSelect: 'all' }}>docker compose --profile rerank up -d</code>
                {' '}and reload this page; a toggle appears here. Measure before trusting it.
              </div>
            )}

            {availableLanguages.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>
                  Note languages
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {availableLanguages.map(lang => {
                    const on = ftsLanguages.includes(lang);
                    return (
                      <button
                        key={lang}
                        onClick={() => setFtsLanguages(prev => (
                          // Never empty: no stemmer means exact word forms only.
                          on ? (prev.length > 1 ? prev.filter(l => l !== lang) : prev) : [...prev, lang]
                        ))}
                        style={{
                          background: on ? '#313244' : '#11111b',
                          border: `1px solid ${on ? '#89b4fa' : '#313244'}`,
                          borderRadius: 6,
                          color: on ? '#cdd6f4' : '#6c7086',
                          padding: '4px 9px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
                        }}
                      >
                        {lang}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: '#6c7086', lineHeight: 1.5 }}>
                  Keyword search matches word forms — with German on,
                  &quot;Einrichtung&quot; is found by &quot;einrichten&quot;. Pick the languages your
                  notes are actually written in; saving rebuilds the text index.
                  Embeddings are not affected.
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: '#6c7086', background: '#11111b', borderRadius: 6, padding: '8px 10px', marginBottom: 16 }}>
              Switching the provider marks every note for reindexing but doesn&apos;t run it —
              click &quot;Reindex&quot; below when ready. &quot;Reindex&quot; only catches notes that
              were never embedded; after an update that changes how embeddings themselves are
              computed, use &quot;Reindex all&quot; to recompute every note.
            </div>

            {settingsStatus && (
              <div style={{ fontSize: 12, color: reindexRunning ? '#f9e2af' : settingsFailed ? '#f38ba8' : '#a6e3a1', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                {reindexRunning && <div style={{ width: 10, height: 10, border: '2px solid #313244', borderTopColor: '#f9e2af', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />}
                {settingsStatus}
              </div>
            )}

            {reindexRunning && reindexProgress && reindexProgress.total > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ height: 6, background: '#11111b', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.round((reindexProgress.done / reindexProgress.total) * 100)}%`, background: '#89b4fa', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: 11, color: '#6c7086', marginTop: 4 }}>
                  {reindexProgress.done} / {reindexProgress.total} ({Math.round((reindexProgress.done / reindexProgress.total) * 100)}%)
                </div>
              </div>
            )}

            {reindexProgress && reindexProgress.errors.length > 0 && (
              <div style={{ maxHeight: 140, overflowY: 'auto', marginBottom: 12, background: '#11111b', borderRadius: 6, padding: '6px 8px' }}>
                {reindexProgress.errors.map((e, i) => (
                  <div key={`${e.id}-${i}`} style={{ fontSize: 11, padding: '4px 0', borderBottom: i < reindexProgress.errors.length - 1 ? '1px solid #1e1e2e' : 'none' }}>
                    <div style={{ color: '#cdd6f4', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || e.id}</div>
                    <div style={{ color: '#f38ba8' }}>{e.message}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              {reindexRunning ? (
                <button
                  onClick={stopReindex}
                  disabled={stopping}
                  title="Stop after the note currently being embedded — the rest stay queued for the next run"
                  style={{ flex: 2, background: '#313244', border: '1px solid #f38ba8', borderRadius: 6, color: '#f38ba8', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: stopping ? 'not-allowed' : 'pointer', opacity: stopping ? 0.7 : 1, fontFamily: 'inherit' }}
                >
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => runReindex('pending')}
                    disabled={settingsSaving}
                    title="Only re-embeds notes that were never embedded"
                    style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: settingsSaving ? 'not-allowed' : 'pointer', opacity: settingsSaving ? 0.7 : 1, fontFamily: 'inherit' }}
                  >
                    Reindex
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm('Recompute embeddings for every note? This can take a while on a large vault.')) return;
                      runReindex('all');
                    }}
                    disabled={settingsSaving}
                    title="Recompute every note's embedding, even already-indexed ones"
                    style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: settingsSaving ? 'not-allowed' : 'pointer', opacity: settingsSaving ? 0.7 : 1, fontFamily: 'inherit' }}
                  >
                    Reindex all
                  </button>
                </>
              )}
              <button
                onClick={saveSettings}
                disabled={settingsSaving || reindexRunning}
                style={{ flex: 2, background: '#89b4fa', border: 'none', borderRadius: 6, color: '#1e1e2e', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: settingsSaving || reindexRunning ? 'not-allowed' : 'pointer', opacity: settingsSaving || reindexRunning ? 0.7 : 1, fontFamily: 'inherit' }}
              >
                {settingsSaving ? 'Saving…' : 'Save & Apply'}
              </button>
            </div>

            <div style={{ borderTop: '1px solid #313244', marginTop: 16, paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Vault backup — markdown files with frontmatter, folders as directories.
                Import skips notes whose titles already exist.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={exportVault}
                  disabled={importRunning}
                  style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: importRunning ? 'not-allowed' : 'pointer', opacity: importRunning ? 0.7 : 1, fontFamily: 'inherit' }}
                >
                  Export .zip
                </button>
                <label
                  style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: importRunning ? 'not-allowed' : 'pointer', opacity: importRunning ? 0.7 : 1, fontFamily: 'inherit', textAlign: 'center' }}
                >
                  {importRunning ? 'Importing…' : 'Import .zip'}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    disabled={importRunning}
                    onChange={e => importVault(e.target)}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </div>
            </>
            )}

            {settingsTab === 'connect' && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Connect an agent</label>
              <select
                value={mcpClient}
                onChange={e => { setMcpClient(e.target.value as typeof mcpClient); setMcpCopied(false); }}
                style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 8, outline: 'none' }}
              >
                <option value="claude-code">Claude Code</option>
                <option value="claude-desktop">Claude Desktop</option>
                <option value="cursor">Cursor</option>
                <option value="windsurf">Windsurf</option>
              </select>
              <div style={{ fontSize: 11, color: '#585b70', marginBottom: 6 }}>
                Put this in{' '}
                <code style={{ color: '#a6adc8', userSelect: 'all' }}>{clientPath(mcpClient, clientOs)}</code>
                {/* Only the absolute paths differ per system; a project-relative one does not. */}
                {mcpClient !== 'claude-code' && ` — ${OS_LABEL[clientOs]}`}
              </div>
              <pre style={{ background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px', fontSize: 11, color: '#cdd6f4', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
{mcpSnippet(mcpClient)}
              </pre>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(mcpSnippet(mcpClient)).then(() => {
                      setMcpCopied(true);
                      setTimeout(() => setMcpCopied(false), 2000);
                    }).catch(() => {});
                  }}
                  style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '6px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
                >
                  {mcpCopied ? 'Copied' : 'Copy'}
                </button>
                <span style={{ fontSize: 11, color: '#585b70' }}>
                  {/* Not filled in: it is the key to the whole vault. */}
                  Replace &lt;KYBASE_SECRET&gt; with the value you logged in with.
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#585b70', marginTop: 8, lineHeight: 1.6 }}>
                claude.ai needs none of this — add a custom connector pointing at{' '}
                <code style={{ color: '#a6adc8', userSelect: 'all' }}>{mcpOrigin()}/api/mcp</code> and it registers
                itself, appearing under Connected clients on the Access tab with a token you can revoke.
              </div>
            </div>
            )}

            {settingsTab === 'access' && (
            <>
            <div>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Session — signs this browser out. Does not touch OAuth clients
                below or require rotating your secret.
              </div>
              <button
                onClick={async () => {
                  await fetch('/api/auth/logout', { method: 'POST' });
                  // No client-readable auth flag to clear (see LoginForm) —
                  // refresh re-runs the server component, which reads the
                  // now-cleared cookie and swaps back to the login screen.
                  onClose();
                  router.refresh();
                }}
                style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#f38ba8', padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Log out
              </button>
            </div>

            <div style={{ borderTop: '1px solid #313244', marginTop: 16, paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Active share links — everything that is currently public.
                A link is access: revoke the ones you no longer need.
              </div>
              {sortedShares.length === 0 ? (
                <div style={{ fontSize: 12, color: '#6c7086' }}>Nothing is shared.</div>
              ) : (
                <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                  {sortedShares.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1e1e2e' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div title={s.note_title} style={{ fontSize: 13, color: '#cdd6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.note_title}
                        </div>
                        <div style={{ fontSize: 11, color: s.expires_at ? '#6c7086' : '#f9e2af' }}>
                          shared {new Date(s.created_at).toLocaleDateString()} · {s.expires_at ? `expires ${new Date(s.expires_at).toLocaleDateString()}` : 'no expiry'}
                        </div>
                      </div>
                      <button
                        disabled={!s.token}
                        onClick={() => s.token && navigator.clipboard?.writeText(`${window.location.origin}/share/${s.token}`)}
                        title={s.token ? 'Copy link' : 'Created before link re-copying was supported — revoke and recreate to get a copyable link'}
                        style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: s.token ? '#cdd6f4' : '#6c7086', padding: '5px 10px', fontSize: 12, cursor: s.token ? 'pointer' : 'not-allowed', fontFamily: 'inherit', flexShrink: 0 }}
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => revokeShareLink(s.note_id, s.id)}
                        title="Revoke link"
                        style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#f38ba8', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid #313244', marginTop: 16, paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Connected clients — OAuth tokens issued to MCP clients (Claude, etc.).
                Revoking disconnects that client without touching your secret.
              </div>
              {oauthClients.length === 0 ? (
                <div style={{ fontSize: 12, color: '#6c7086' }}>No active OAuth clients.</div>
              ) : (
                <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                  {oauthClients.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1e1e2e' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div title={c.client_name || 'Unnamed client'} style={{ fontSize: 13, color: '#cdd6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.client_name || 'Unnamed client'}
                        </div>
                        <div style={{ fontSize: 11, color: '#6c7086' }}>
                          last used {new Date(c.last_used_at).toLocaleString()} · expires {new Date(c.expires_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={() => revokeClient(c.id)}
                        title="Revoke access"
                        style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#f38ba8', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid #313244', marginTop: 16, paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Trash — deleted notes, kept for 30 days before being purged for good.
              </div>
              {trashError && (
                <div style={{ fontSize: 12, color: '#f38ba8', marginBottom: 8 }}>{trashError}</div>
              )}
              {trash.length === 0 ? (
                <div style={{ fontSize: 12, color: '#6c7086' }}>Trash is empty.</div>
              ) : (
                <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                  {trash.map(n => (
                    <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1e1e2e' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div title={n.title} style={{ fontSize: 13, color: '#cdd6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {n.title}
                        </div>
                        <div style={{ fontSize: 11, color: '#6c7086' }}>
                          deleted {new Date(n.deleted_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={() => restoreNote(n.id)}
                        title="Restore this note"
                        style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#a6e3a1', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => purgeNote(n.id, n.title)}
                        title="Permanently delete — skips the rest of the 30-day trash window"
                        style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#f38ba8', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
                      >
                        Delete forever
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            </>
            )}
          </div>
        </div>
  );
}
