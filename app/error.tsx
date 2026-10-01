'use client';

import { useEffect } from 'react';

// Route-level error boundary — without it a render crash leaves a blank page.
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: 16,
        background: '#11111b',
        color: '#cdd6f4',
        fontFamily: 'system-ui, sans-serif',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Something went wrong</h1>
      <p style={{ margin: 0, color: '#a6adc8', fontSize: '0.9rem', maxWidth: 480 }}>
        {error.message || 'An unexpected error occurred while rendering the page.'}
        {error.digest ? ` (digest: ${error.digest})` : ''}
      </p>
      <button
        onClick={() => unstable_retry()}
        style={{
          padding: '10px 24px',
          background: '#89b4fa',
          color: '#11111b',
          border: 'none',
          borderRadius: 6,
          fontSize: '0.95rem',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}
