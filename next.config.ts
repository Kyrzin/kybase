import type { NextConfig } from "next";

// Second line of defence behind the escape-first markdown renderer: even if
// an XSS payload slipped through, it could not load external scripts or
// exfiltrate to another origin. 'unsafe-inline' script-src is required by
// Next's bootstrap scripts; styles are inline throughout the app; Google
// Fonts is the only external origin (see app/layout.tsx). The share page
// and the authorize form set their own, stricter CSP — browsers enforce
// every policy present, so the strictest one wins there.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  output: "standalone",
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
