// Auth is a session cookie (httpOnly, set by /api/auth/check) that the
// browser attaches to same-origin requests on its own — nothing to read
// or forward here.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}
