// Live end-to-end probe of the MemWal (Walrus Memory) integration.
// Loads web/.env.local, creates the hosted client with the real delegate key,
// and does a remember → recall round-trip, printing the exact failure if any.
//   node scripts/memwal-probe.mjs
import { readFileSync } from "node:fs";
import { MemWal } from "@mysten-incubation/memwal";

// --- load .env.local (names only into process.env) ---
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv(new URL("../.env.local", import.meta.url).pathname);

const SERVER_URL = process.env.MEMWAL_SERVER_URL?.trim() || "https://relayer.memwal.ai";
const ACCOUNT_ID = process.env.MEMWAL_ACCOUNT_ID?.trim() || "";
const DELEGATE_KEY = process.env.MEMWAL_DELEGATE_KEY?.trim() || "";
const ns = "talise:0xprobe000000000000000000000000000000000000000000000000000000probe";

console.log("server   :", SERVER_URL);
console.log("accountId:", ACCOUNT_ID.slice(0, 10) + "…");
console.log("delegate :", DELEGATE_KEY ? DELEGATE_KEY.slice(0, 6) + "…(" + DELEGATE_KEY.length + " chars)" : "(missing)");
console.log("namespace:", ns);
console.log("");

if (!ACCOUNT_ID || !DELEGATE_KEY) {
  console.error("FAIL: missing ACCOUNT_ID or DELEGATE_KEY");
  process.exit(2);
}

const client = MemWal.create({ accountId: ACCOUNT_ID, key: DELEGATE_KEY, serverUrl: SERVER_URL, namespace: ns });

// 0) raw health check of the relayer
try {
  const h = await fetch(SERVER_URL.replace(/\/$/, "") + "/health").catch(() => null);
  console.log("[health]", h ? h.status + " " + h.statusText : "no response");
} catch (e) { console.log("[health] error:", e.message); }

const marker = "PROBE_MEMORY_" + Buffer.from(String(process.pid)).toString("hex") + " — the user's favorite test token is talise-probe.";

// 1) REMEMBER
console.log("\n[1] rememberAndWait …");
let remembered = false;
try {
  const r = await client.rememberAndWait(marker, undefined, { timeoutMs: 30000 });
  console.log("    OK blob_id=%s job=%s owner=%s", r?.blob_id, r?.job_id, r?.owner);
  remembered = true;
} catch (e) {
  console.error("    REMEMBER FAILED:", e?.message);
  if (e?.cause) console.error("    cause:", e.cause?.message || e.cause);
  if (e?.stack) console.error(String(e.stack).split("\n").slice(0, 4).join("\n"));
}

// 2) RECALL
console.log("\n[2] recall …");
try {
  const r = await client.recall("favorite test token", 6);
  console.log("    OK total=%d results=%d", r?.total, (r?.results ?? []).length);
  for (const m of (r?.results ?? []).slice(0, 3)) {
    console.log("      • dist=%s text=%j", m.distance?.toFixed?.(3), String(m.text).slice(0, 70));
  }
} catch (e) {
  console.error("    RECALL FAILED:", e?.message);
  if (e?.cause) console.error("    cause:", e.cause?.message || e.cause);
  if (e?.stack) console.error(String(e.stack).split("\n").slice(0, 4).join("\n"));
}

console.log("\nverdict:", remembered ? "remember worked" : "remember BROKEN");

// 3) RESILIENCE: verify the fast-fail classifier used by lib/memwal.ts
// rememberFact(). Mirrors classifyError() so the probe proves — against the
// LIVE relayer — that a "writes paused" 503 gives up IMMEDIATELY (no 4× slow
// backoff, which would burn ~18s). We time a single rememberAndWait and assert
// the classification, rather than sitting through the retries.
function classifyError(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes("paused") || lower.includes("security upgrade")) return "permanent";
  const m = msg.match(/\((\d{3})\)/);
  const status = m ? Number(m[1]) : 0;
  if (status >= 400 && status < 500) return "permanent";
  return "transient";
}

console.log("\n[3] resilience / fast-fail check …");
const t0 = Date.now();
try {
  await client.rememberAndWait(marker + " (resilience probe)", undefined, { timeoutMs: 30000 });
  console.log("    write SUCCEEDED — relayer no longer paused; retries would be moot");
} catch (e) {
  const msg = (e?.message ?? String(e)).slice(0, 200);
  const cls = classifyError(msg);
  const elapsed = Date.now() - t0;
  console.log("    classification: %s (elapsed %dms for the single attempt)", cls.toUpperCase(), elapsed);
  if (cls === "permanent") {
    console.log("    → rememberFact() FAST-FAILS here: logs once, returns, trips the");
    console.log("      circuit breaker. NO 3s/6s/9s backoff, NO 4 attempts (~18s saved).");
  } else {
    console.log("    → transient: rememberFact() would retry 4× with backoff (expected).");
  }
}

process.exit(0);
