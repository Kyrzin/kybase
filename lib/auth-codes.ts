interface CodeEntry {
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
}

const codes = new Map<string, CodeEntry>();

export function storeCode(code: string, entry: CodeEntry): void {
  codes.set(code, entry);
  setTimeout(() => codes.delete(code), 10 * 60 * 1000);
}

export function consumeCode(code: string): CodeEntry | undefined {
  const entry = codes.get(code);
  if (!entry) return undefined;
  codes.delete(code);
  if (entry.expiresAt < Date.now()) return undefined;
  return entry;
}
