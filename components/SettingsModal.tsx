'use client';

// components/SettingsModal.tsx — the Settings dialog (Embeddings + Access
// tabs), extracted from KybaseApp. Owns all settings-local state; the parent
// passes apiFetch, refresh setters for import, and a share-revoke callback so
// it can dismiss the editor's share popover if it shows a just-revoked token.
import { useState, useEffect } from 'react';
import type { Note, Folder } from '@/lib/types';

type OAuthClient = { id: string; client_name: string | null; created_at: string; last_used_at: string; expires_at: string };
type ShareItem = { token: string; note_id: string; note_title: string; created_at: string; expires_at: string | null };

export default function SettingsModal({ apiFetch, onClose, setNotes, setFolders, onShareRevoked }: {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  onShareRevoked: (token: string) => void;
}) {
  const [settingsProvider, setSettingsProvider] = useState<'ollama' | 'google' | 'openai'>('ollama');
  const [settingsGoogleKey, setSettingsGoogleKey] = useState('');
  const [settingsOpenaiKey, setSettingsOpenaiKey] = useState('');
  const [settingsOllamaModel, setSettingsOllamaModel] = useState('nomic-embed-text');
  const [settingsSaving, setSettingsSaving]   = useState(false);
  const [settingsStatus, setSettingsStatus]   = useState<string | null>(null);
  const [reindexRunning, setReindexRunning]   = useState(false);
  const [importRunning, setImportRunning]     = useState(false);
  const [settingsTab, setSettingsTab]         = useState<'embeddings' | 'access'>('embeddings');
  const [oauthClients, setOauthClients]       = useState<OAuthClient[]>([]);
  const [shares, setShares]                   = useState<ShareItem[]>([]);

  useEffect(() => {
    apiFetch('/api/settings').then(r => r.json()).then(data => {
      setSettingsProvider(data.provider ?? 'ollama');
      setSettingsOllamaModel(data.ollamaModel ?? 'nomic-embed-text');
      setSettingsStatus(null);
    });
    apiFetch('/api/oauth/clients')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (Array.isArray(d)) setOauthClients(d); })
      .catch(() => {});
    apiFetch('/api/shares')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (Array.isArray(d)) setShares(d); })
      .catch(() => {});
  }, [apiFetch]);

  const revokeClient = async (id: string) => {
    const res = await apiFetch(`/api/oauth/clients/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setOauthClients(prev => prev.filter(c => c.id !== id));
    }
  };

  const revokeShareLink = async (noteId: string, token: string) => {
    const res = await apiFetch(`/api/notes/${noteId}/share/${token}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setShares(prev => prev.filter(s => s.token !== token));
      onShareRevoked(token);
    }
  };

  // Permanent links first (they're the ones to worry about), then newest.
  const sortedShares = [...shares].sort((a, b) => {
    if (!a.expires_at !== !b.expires_at) return a.expires_at ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const saveSettings = async () => {
    setSettingsSaving(true);
    setSettingsStatus(null);
    try {
      const body: Record<string, string> = { provider: settingsProvider, ollamaModel: settingsOllamaModel };
      if (settingsGoogleKey) body.googleApiKey = settingsGoogleKey;
      if (settingsOpenaiKey) body.openaiApiKey = settingsOpenaiKey;
      const res = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.reindexTriggered) {
        setSettingsStatus('Saved. Reindexing…');
        setReindexRunning(true);
        const ri = await apiFetch('/api/admin/reindex', { method: 'POST' });
        const riData = await ri.json();
        setSettingsStatus(`Done. Reindexed ${riData.reindexed} notes.`);
        setReindexRunning(false);
      } else {
        setSettingsStatus('Settings saved.');
      }
    } catch {
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
              {([['embeddings', 'Embeddings'], ['access', `Access (${shares.length + oauthClients.length})`]] as const).map(([tab, label]) => (
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
            <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Provider</label>
            <select value={settingsProvider} onChange={e => setSettingsProvider(e.target.value as 'ollama' | 'google' | 'openai')} style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }}>
              <option value="ollama">Ollama (local, free)</option>
              <option value="google">Google text-embedding-004 (free tier)</option>
              <option value="openai">OpenAI text-embedding-3-small</option>
            </select>

            {settingsProvider === 'ollama' && (
              <>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Model</label>
                <input value={settingsOllamaModel} onChange={e => setSettingsOllamaModel(e.target.value)} placeholder="nomic-embed-text" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
              </>
            )}

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

            <div style={{ fontSize: 11, color: '#6c7086', background: '#11111b', borderRadius: 6, padding: '8px 10px', marginBottom: 16 }}>
              Switching the provider automatically re-indexes all notes.
            </div>

            {settingsStatus && (
              <div style={{ fontSize: 12, color: reindexRunning ? '#f9e2af' : '#a6e3a1', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                {reindexRunning && <div style={{ width: 10, height: 10, border: '2px solid #313244', borderTopColor: '#f9e2af', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />}
                {settingsStatus}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => {
                  setReindexRunning(true);
                  setSettingsStatus('Reindexing…');
                  try {
                    const ri = await apiFetch('/api/admin/reindex', { method: 'POST' });
                    const riData = await ri.json();
                    setSettingsStatus(`Done. Reindexed ${riData.reindexed} notes.`);
                  } catch {
                    setSettingsStatus('Reindex failed.');
                  } finally {
                    setReindexRunning(false);
                  }
                }}
                disabled={reindexRunning || settingsSaving}
                style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: reindexRunning || settingsSaving ? 'not-allowed' : 'pointer', opacity: reindexRunning || settingsSaving ? 0.7 : 1, fontFamily: 'inherit' }}
              >
                {reindexRunning ? 'Indexing…' : 'Reindex'}
              </button>
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

            {settingsTab === 'access' && (
            <>
            <div>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Active share links — everything that is currently public.
                A link is access: revoke the ones you no longer need.
              </div>
              {sortedShares.length === 0 ? (
                <div style={{ fontSize: 12, color: '#6c7086' }}>Nothing is shared.</div>
              ) : (
                <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                  {sortedShares.map(s => (
                    <div key={s.token} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1e1e2e' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div title={s.note_title} style={{ fontSize: 13, color: '#cdd6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.note_title}
                        </div>
                        <div style={{ fontSize: 11, color: s.expires_at ? '#6c7086' : '#f9e2af' }}>
                          shared {new Date(s.created_at).toLocaleDateString()} · {s.expires_at ? `expires ${new Date(s.expires_at).toLocaleDateString()}` : 'no expiry'}
                        </div>
                      </div>
                      <button
                        onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/share/${s.token}`)}
                        title="Copy link"
                        style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => revokeShareLink(s.note_id, s.token)}
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
            </>
            )}
          </div>
        </div>
  );
}
