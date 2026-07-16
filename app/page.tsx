'use client';

import { useState, useSyncExternalStore } from 'react';
import KybaseApp from '@/components/KybaseApp';

const TOKEN_KEY = 'kybase_token';
const AUTH_EVENT = 'kybase-auth';

// localStorage as an external store: the server snapshot renders the login
// form, the client snapshot takes over right after hydration — no
// mounted-flag effect, no hydration mismatch.
function subscribeAuth(onChange: () => void) {
  window.addEventListener(AUTH_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(AUTH_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
const hasToken = () => !!localStorage.getItem(TOKEN_KEY);

export default function Page() {
  const authenticated = useSyncExternalStore(subscribeAuth, hasToken, () => false);
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  if (!authenticated) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: '#1e1e2e', flexDirection: 'column', gap: 16,
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="3" stroke="url(#lg)" strokeWidth="2" />
            <path d="M8 12h8M12 8v8" stroke="url(#lg)" strokeWidth="2" strokeLinecap="round" />
            <defs>
              <linearGradient id="lg" x1="3" y1="3" x2="21" y2="21">
                <stop stopColor="#89b4fa" />
                <stop offset="1" stopColor="#b4befe" />
              </linearGradient>
            </defs>
          </svg>
          <span style={{
            fontSize: 20, fontWeight: 700,
            background: 'linear-gradient(135deg,#89b4fa,#b4befe)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>Kybase</span>
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            setError('');
            try {
              const res = await fetch('/api/auth/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret: password }),
              });
              if (res.ok) {
                localStorage.setItem(TOKEN_KEY, password);
                window.dispatchEvent(new Event(AUTH_EVENT));
              } else {
                setError('Wrong password');
              }
            } finally {
              setLoading(false);
            }
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 280 }}
        >
          <input
            type="password"
            placeholder="Enter secret"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{
              background: '#313244', border: '1px solid #45475a', borderRadius: 6,
              color: '#cdd6f4', padding: '10px 12px', fontSize: 14,
              fontFamily: 'inherit', outline: 'none',
            }}
          />
          {error && (
            <span style={{ color: '#f38ba8', fontSize: 13 }}>{error}</span>
          )}
          <button
            type="submit"
            disabled={loading || !password}
            style={{
              background: 'linear-gradient(135deg,#89b4fa,#b4befe)',
              border: 'none', borderRadius: 6, color: '#1e1e2e',
              padding: 10, cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 600, fontSize: 14, fontFamily: 'inherit',
              opacity: loading || !password ? 0.6 : 1,
            }}
          >
            {loading ? 'Checking…' : 'Enter'}
          </button>
        </form>
      </div>
    );
  }

  return <KybaseApp />;
}
