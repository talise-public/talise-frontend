# Talise web — multi-stage Dockerfile.
#
# Use this when deploying somewhere that doesn't auto-detect Next.js
# (Fly.io, bare Docker, K8s). Railway prefers Nixpacks via railway.toml,
# so this file is a fallback / portability hedge.
#
# Image layout:
#   1. deps      — install pnpm deps from the lockfile (cacheable)
#   2. build     — compile Next.js (uses standalone output mode)
#   3. runner    — minimal Node 20 image with just the standalone bundle
#                  + a writable /app/.data volume for the SQLite file
# Final image: ~180 MB.

# ─── 1. deps ─────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Native libs that libSQL's better-sqlite3 fallback needs at build time.
# Alpine is musl so we need libc6-compat for prebuilt binaries.
RUN apk add --no-cache libc6-compat

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# ─── 2. build ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js standalone output trims node_modules to only what the server
# actually needs — see next.config.ts.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ─── 3. runner ───────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user — required by some platforms (Cloud Run, K8s PSPs).
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Standalone output + static assets + public assets.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# SQLite file lives here. Mount a volume at /app/.data in production so
# the DB survives container restarts.
RUN mkdir -p /app/.data && chown -R nextjs:nodejs /app/.data
VOLUME ["/app/.data"]

USER nextjs

# Next.js reads PORT from env.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Healthcheck shells out to wget (busybox provides it on Alpine).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
