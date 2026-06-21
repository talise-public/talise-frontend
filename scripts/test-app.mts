/**
 * End-to-end function check for the Talise iOS app.
 *
 * Mints a bearer for an existing user, then walks every endpoint the
 * iOS UI calls and reports pass/fail. Doesn't broadcast any tx — only
 * preview/build paths so we don't burn gas.
 */
import { randomBytes, createHash, createHmac } from "node:crypto";
import { createClient } from "@libsql/client";

const DB = createClient({ url: process.env.DATABASE_URL ?? "file:.data/talise.db" });

// Mint a bearer directly via the same flow lib/mobile-sessions.ts uses,
// so /api routes that call readEntryIdFromRequest(req) will authenticate
// our test calls.
async function mintTestBearer(userId: number): Promise<string> {
  // We can't import lib/auth.ts directly (server-only). Re-implement the
  // sign() call inline: HMAC-SHA256 of the token with SESSION_SECRET,
  // then `token.signature` base64url.
  const SESSION_SECRET = process.env.SESSION_SECRET!;
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET not set in env");
  const token = randomBytes(32).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET)
    .update(token)
    .digest("base64url");
  const signed = `${token}.${sig}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const expires = now + 1000 * 60 * 15; // 15 minutes
  await DB.execute({
    sql: `INSERT INTO mobile_sessions (token_hash, user_id, device_id, jwt, salt, created_at, expires_at, revoked)
          SELECT ?, ?, 'test-script', m.jwt, m.salt, ?, ?, 0
          FROM mobile_sessions m WHERE m.user_id = ? AND m.jwt IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 1`,
    args: [tokenHash, userId, now, expires, userId],
  });
  return signed;
}

const BASE = "http://localhost:3000";
const results: Array<{ name: string; status: "✓" | "✗" | "—"; detail: string }> = [];

async function hit(
  name: string,
  path: string,
  opts: { method?: string; body?: unknown; bearer: string; expect?: (r: Response, body: unknown) => string | null }
) {
  try {
    const req: RequestInit = {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.bearer}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    };
    const r = await fetch(BASE + path, req);
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch {}
    const expectFn = opts.expect;
    const check = expectFn?.(r, parsed) ?? null;
    if (check) {
      results.push({ name, status: "✗", detail: `[${r.status}] ${check}` });
    } else if (expectFn) {
      // Caller provided an expect and it returned null — trust them
      // even on 4xx/5xx (used for reachability probes).
      results.push({ name, status: "✓", detail: `HTTP ${r.status}` });
    } else if (r.status >= 400) {
      const errMsg = (parsed as { error?: string })?.error ?? text.slice(0, 60);
      results.push({ name, status: "✗", detail: `HTTP ${r.status}: ${errMsg}` });
    } else {
      results.push({ name, status: "✓", detail: `HTTP ${r.status}` });
    }
  } catch (e) {
    results.push({ name, status: "✗", detail: (e as Error).message.slice(0, 80) });
  }
}

// ---

// Pick a user with a live mobile session (so jwt/salt are populated for
// the zkLogin-requiring endpoints).
const userRow = await DB.execute(`
  SELECT u.id, u.email, u.sui_address
  FROM users u
  JOIN mobile_sessions ms ON ms.user_id = u.id
  WHERE ms.jwt IS NOT NULL AND ms.salt IS NOT NULL
  ORDER BY ms.created_at DESC LIMIT 1
`);
if (userRow.rows.length === 0) {
  console.error("No user with a live jwt/salt session in DB. Sign in once via the app first.");
  process.exit(1);
}
const user = userRow.rows[0] as { id: number; email: string; sui_address: string };
console.log(`Testing as user ${user.id} (${user.email}) addr ${user.sui_address.slice(0,10)}…${user.sui_address.slice(-6)}\n`);

const bearer = await mintTestBearer(user.id);

// ─── Read-only endpoints ────────────────────────────────────────────
await hit("GET /api/me", "/api/me", {
  bearer,
  expect: (r, b) => {
    const u = b as { suiAddress?: string };
    return u?.suiAddress ? null : "missing suiAddress";
  },
});
await hit("GET /api/balances", "/api/balances", {
  bearer,
  expect: (_, b) => (typeof (b as { usdsui?: number }).usdsui === "number" ? null : "missing usdsui"),
});
await hit("GET /api/activity?limit=20", "/api/activity?limit=20", {
  bearer,
  expect: (_, b) => (Array.isArray((b as { entries?: unknown[] }).entries) ? null : "missing entries"),
});
await hit("GET /api/contacts", "/api/contacts", {
  bearer,
  expect: (_, b) => (Array.isArray((b as { contacts?: unknown[] }).contacts) ? null : "missing contacts"),
});
await hit("GET /api/yield/comparison", "/api/yield/comparison", {
  bearer,
  expect: (_, b) => (Array.isArray((b as { venues?: unknown[] }).venues) ? null : "missing venues"),
});
await hit("GET /api/referral/summary", "/api/referral/summary", {
  bearer,
  expect: (_, b) => (typeof (b as { code?: string }).code === "string" ? null : "missing code"),
});
await hit("GET /api/sui/epoch", "/api/sui/epoch", {
  bearer,
  expect: (_, b) => (typeof (b as { epoch?: string }).epoch === "string" ? null : "missing epoch"),
});
await hit("GET /api/health", "/api/health", {
  bearer,
  expect: (_, b) => ((b as { ok?: boolean }).ok ? null : "health check not ok"),
});

// SuiNS resolution — try the user's own handle and a known-good name
await hit("GET /api/recipient/resolve?q=eromonsele", "/api/recipient/resolve?q=eromonsele", {
  bearer,
  expect: (r, b) => {
    if (r.status === 404) return null; // ok if no record
    return (b as { address?: string }).address ? null : "no address";
  },
});

// Username availability check (PUBLIC route)
await hit("GET /api/username/check?u=alice", "/api/username/check?u=alice", {
  bearer,
  expect: (_, b) =>
    typeof (b as { available?: boolean }).available === "boolean"
      ? null
      : "missing available field",
});

// ─── Build / prepare endpoints (don't broadcast) ─────────────────────
await hit("POST /api/sweep/prepare (preview)", "/api/sweep/prepare", {
  bearer,
  method: "POST",
  body: { action: "preview" },
  expect: (_, b) =>
    typeof (b as { eligible?: boolean }).eligible === "boolean" ? null : "missing eligible",
});

// /api/send/prepare needs a recipient + amount + asset. Use a different
// known address (jude.talise.sui's target) so we don't self-send.
await hit("POST /api/send/prepare (USDsui)", "/api/send/prepare", {
  bearer,
  method: "POST",
  body: {
    to: "0x64878781d44a087a44cfc8a24c40326873ec8c97ff13d3aced794920e894c8a8",
    amount: 0.01,
    asset: "USDsui",
  },
  expect: (r, b) => {
    if (r.status === 400 && (b as { error?: string }).error?.includes("no USDsui"))
      return "no USDsui in wallet (route works, but no funds)";
    return (b as { transactionKindB64?: string }).transactionKindB64 ? null : "no kind bytes";
  },
});

await hit("POST /api/earn/supply/prepare (DeepBook)", "/api/earn/supply/prepare", {
  bearer,
  method: "POST",
  body: { venue: "deepbook", amount: 0.01 },
  expect: (_, b) =>
    (b as { transactionKindB64?: string }).transactionKindB64 ? null : "no kind bytes",
});

// /api/zk/sponsor needs transactionKindB64 — synthesize a no-op kind. We
// just check the route auths + accepts a payload (it'll fail PTB parse,
// but a 500 here is "route works, payload is bad" not "route is broken").
await hit("POST /api/zk/sponsor (bad payload)", "/api/zk/sponsor", {
  bearer,
  method: "POST",
  body: { transactionKindB64: "AAA=" },
  expect: () => null,  // we accept either 200 or 500 — route reachability is the test
});

// ─── Settings write ─────────────────────────────────────────────────
await hit("POST /api/settings", "/api/settings", {
  bearer,
  method: "POST",
  body: { notifyOnReceive: false },
  expect: () => null,
});

// ─── Sign-out (kept last) ───────────────────────────────────────────
// /api/auth/mobile/start is a GET that redirects to Google — we just
// verify it returns a 3xx Location.
// Valid-looking 32-byte Ed25519 public key (all zeros). The route
// validates length + decodes via Ed25519PublicKey; a 32-byte b64
// blob passes both checks and we get the expected 302 to Google.
const testEphPubB64 = Buffer.alloc(32, 0).toString("base64").replace(/=/g, "");
await hit("GET /api/auth/mobile/start", `/api/auth/mobile/start?ephemeralPubKey=${testEphPubB64}`, {
  bearer,
  expect: (r) => (r.status === 302 || r.status === 200 ? null : `unexpected status ${r.status}`),
});

// ─── Report ─────────────────────────────────────────────────────────
console.log("─".repeat(78));
for (const r of results) {
  console.log(`  ${r.status}  ${r.name.padEnd(48)}  ${r.detail}`);
}
const pass = results.filter((r) => r.status === "✓").length;
const fail = results.filter((r) => r.status === "✗").length;
console.log("─".repeat(78));
console.log(`  ${pass} passing · ${fail} failing · ${results.length} total`);

// Clean up the test bearer
await DB.execute({
  sql: "DELETE FROM mobile_sessions WHERE device_id = 'test-script'",
  args: [],
});
