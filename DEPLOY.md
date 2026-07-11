# Talise — Deployment

The web tier is a single Next.js 15 app (`web/`). It runs anywhere Node 20 + a
durable filesystem (for libSQL) are available — Railway, Fly, Render, K8s, or
plain Docker.

## Quick start: Railway

1. `railway init` from `web/`.
2. Add the libSQL plugin (or point `DATABASE_URL` at a Turso DB).
3. Paste **every** value from `.env.example` into the Railway *Variables*
   panel.
4. `railway up`. The build will use `nixpacks` + `railway.toml`, and the
   service will start serving on the platform-assigned `$PORT`.
5. Set the public domain to your apex (e.g. `talise.io`) — Railway terminates
   TLS for you.

Railway's health probe hits `/api/health` every 30 s. If DB / Sui RPC / Onara
are all reachable the route returns `200 { ok: true }`; otherwise `503` and
traffic gets paused until recovery.

## Quick start: Docker

```bash
cd web
docker build -t talise-web .
docker run -p 3000:3000 \
  --env-file .env.local \
  -v talise-data:/app/.data \
  talise-web
```

The image uses the multi-stage `Dockerfile` and pulls Next.js standalone
output, so the final image is ~180 MB. The SQLite DB lives in the
`/app/.data` volume — mount it persistently or you'll lose user data on
restart.

## Database options

| Option | When to use | Set |
|---|---|---|
| Local file (`file:./.data/talise.db`) | Single replica, persistent volume, low write volume | `DATABASE_URL=file:./.data/talise.db` |
| **Turso** (recommended for prod) | Multi-region replicas, low-latency reads, free tier covers ~9k DAU | `DATABASE_URL=libsql://<your-db>.turso.io` + `DATABASE_AUTH_TOKEN=…` |
| Railway libSQL service | Single-region, zero ops, scales with the rest of your stack | Inject from the service env |

The schema auto-migrates on first DB hit — see `lib/db.ts:ensureSchema`. No
manual migration step needed. `CREATE TABLE IF NOT EXISTS` + idempotent
`ALTER TABLE` make redeploys safe.

## One-time bootstraps

After the first deploy, run these once:

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
| `DATABASE_URL` | Where state lives. |

Everything else has a sensible default or is optional.
