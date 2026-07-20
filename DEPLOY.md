# Talise — Deployment

> **Production runs on Vercel with Postgres.** Railway/Docker below are
> legacy/alternative and may be out of date.

The web tier is a single Next.js 15 app (`web/`). In production it is deployed
to **Vercel** with a managed **Postgres** database (`DATABASE_URL` is a standard
`postgres://USER:PASS@HOST:PORT/DB` URL). The app enforces Postgres at runtime —
`lib/db.ts` connects with the `postgres` driver and there is no SQLite/libSQL
code path. `DATABASE_AUTH_TOKEN` is ignored for Postgres deployments.

## Quick start: Vercel (production)

1. Import the repo into Vercel and set the project root to `web/`.
2. Provision a Postgres database (Vercel Postgres, Supabase, Neon, or any
   `postgres://` host) and set `DATABASE_URL` to its connection string.
   - Behind a transaction pooler (e.g. Supabase pooled `:6543` / PgBouncer),
     append `?pgbouncer=true` so prepared statements are auto-disabled.
3. Paste **every** value from `.env.example` into the Vercel *Environment
   Variables* panel (Production, and Preview if you want previews to work).
4. Deploy. Vercel builds `next build` and serves the app on serverless
   functions; the schema auto-migrates on first DB hit (see below).
5. Point your apex (e.g. `talise.io`) at the Vercel project — Vercel
   terminates TLS for you.

The health route `/api/health` returns `200 { ok: true }` when DB / Sui RPC /
Onara are reachable, otherwise `503`.

## Database

The one supported production database is **Postgres**. Set:

```
DATABASE_URL=postgres://user:pass@host:5432/db
```

TLS is negotiated automatically (`sslmode=disable|require` in the URL is
honoured; otherwise TLS is preferred with a plain-text fallback). The schema
auto-migrates on first DB hit — see `lib/db.ts:ensureSchema`. No manual
migration step is needed: `CREATE TABLE IF NOT EXISTS` + idempotent
`ALTER TABLE` make redeploys safe.

## One-time bootstraps

After the first deploy, run these once (locally, with the prod `DATABASE_URL` /
operator key in your `.env.local`):

```bash
# Mint the global PaymentRegistry on chain (~0.005 SUI gas, paid by operator).
# IDEMPOTENT — re-running is a no-op.
pnpm pk:bootstrap
```

Then verify:

```bash
curl https://<your-domain>/api/health
# expect: { ok: true, legs: { db: { ok: true }, sui: { ok: true }, onara: { ok: true } } }
```

## Secrets that absolutely must be set

| Var | Why |
|---|---|
| `SESSION_SECRET` | HMAC-signs every cookie. If missing, sign-in is broken. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth — sign-in fails without these. |
| `SHINAMI_API_KEY` | zkLogin proof minting on mainnet. |
| `ONARA_URL` | Gas sponsorship. Sends fail without it. |
| `TALISE_SUINS_OPERATOR_KEY` | Mints `<name>.talise.sui` subnames + the Payment Kit registry. |
| `DATABASE_URL` | Postgres connection string. Where all state lives. |

Everything else has a sensible default or is optional.

---

## Legacy / alternative: Railway + Docker

> The steps below are **legacy** and may be out of date. Vercel + Postgres
> (above) is the canonical production deploy target. The app requires a
> `postgres://` `DATABASE_URL` regardless of host — there is no SQLite/libSQL
> path in the current code, so any container host must still point
> `DATABASE_URL` at a Postgres instance.

### Railway

1. `railway init` from `web/`.
2. Add a **Postgres** plugin and point `DATABASE_URL` at it (a `postgres://`
   URL — not libSQL/Turso).
3. Paste **every** value from `.env.example` into the Railway *Variables*
   panel.
4. `railway up`. The build uses `nixpacks` + `railway.toml`, and the service
   serves on the platform-assigned `$PORT`.
5. Set the public domain to your apex — Railway terminates TLS for you.

### Docker

```bash
cd web
docker build -t talise-web .
docker run -p 3000:3000 \
  --env-file .env.local \
  talise-web
```

The image uses the multi-stage `Dockerfile` and pulls Next.js standalone
output. State lives in the external Postgres pointed to by `DATABASE_URL`; the
container itself is stateless (no local DB file to persist).
