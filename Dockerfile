# ── Stage 1: deps ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline

# ── Stage 2: builder ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time placeholder — real secrets injected at runtime via env
ENV KYBASE_SECRET=placeholder
ENV EMBEDDING_PROVIDER=ollama

RUN npm run build

# ── Stage 3: runner ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Bind all interfaces: the standalone server listens on HOSTNAME, and the
# container hostname resolves to a single network's IP — with more than one
# network attached the reachable interface is a coin toss.
ENV HOSTNAME=0.0.0.0

# Copy standalone output (next.config.ts: output: 'standalone').
# chown so the runtime cache (.next/cache) stays writable for the node user.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static      ./.next/static
COPY --from=builder --chown=node:node /app/public            ./public
# Migration files are read from disk at startup (lib/migrate.ts) — the
# standalone output tracer doesn't pick up runtime fs reads.
COPY --from=builder --chown=node:node /app/db/migrations     ./db/migrations

USER node

EXPOSE 3000
CMD ["node", "server.js"]
