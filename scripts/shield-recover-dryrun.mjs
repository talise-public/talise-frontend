// Shielded-pool recovery DRY RUN — proves the escrowed note master owns the
// stranded shielded balance. Scans commitments and trial-decrypts them with the
// recovered viewing key. NO transaction is built or sent; NO money moves.
//
// Run:
//   node --loader ./scripts/shield-node-loader.mjs scripts/shield-recover-dryrun.mjs
//
// The note master is read from the DB escrow and NEVER printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deriveShieldKeypairFromSeed, deriveShieldEncScalar, poseidonStub } from "../lib/shield/sdk/keys.ts";
import { scanNotes } from "../lib/shield/sdk/scan.ts";

const API = process.env.SHIELD_API_BASE || "https://app.talise.io";
const hash3 = (a, b, c) => poseidonStub([a, b, c]);
const nullifierFor = (sk, commitment, pathIndex) =>
  hash3(commitment, pathIndex, hash3(sk, commitment, pathIndex));

const USER_ID = process.env.RECOVER_USER_ID || "1";
const USDSUI =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

// ── DB access (read-only) ───────────────────────────────────────────────────
const dbUrl = (() => {
  const line = readFileSync(".env.local", "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  const raw = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return raw.split("?")[0] + "?sslmode=require";
})();
const q = (sql) =>
  execFileSync("psql", [dbUrl, "-Atc", sql], { encoding: "utf8" }).trim();

// ── 1. Recover the note master (SECRET — never logged) ──────────────────────
const master = q(`SELECT note_master FROM shield_key_escrow WHERE user_id='${USER_ID}'`);
if (!/^[0-9a-fA-F]{32,128}$/.test(master)) {
  console.error(`no escrowed note master for user ${USER_ID} (got ${master.length} chars)`);
  process.exit(1);
}
const seed = Uint8Array.from(master.match(/../g).map((h) => parseInt(h, 16)));
console.log(`✓ recovered note master for user ${USER_ID} (${seed.length} bytes, value hidden)`);

// ── 2. Derive keys from the master ──────────────────────────────────────────
const keypair = await deriveShieldKeypairFromSeed(seed);
const viewingKey = await deriveShieldEncScalar(keypair.spendingKey);
console.log("✓ derived shield spend + viewing keys from the master");

// ── 3. Load all USDsui commitments from the DB (the indexer feed) ────────────
const raw = q(
  `SELECT leaf_index || '|' || commitment || '|' || coalesce(encrypted_output,'') ` +
    `FROM shield_commitments WHERE coin_type='${USDSUI}' ORDER BY leaf_index`
);
const allRows = raw
  ? raw.split("\n").map((line) => {
      const i = line.indexOf("|");
      const j = line.indexOf("|", i + 1);
      return {
        leafIndex: Number(line.slice(0, i)),
        commitment: line.slice(i + 1, j),
        encryptedOutput: line.slice(j + 1) || null,
      };
    })
  : [];
console.log(`✓ loaded ${allRows.length} USDsui commitment(s) from the pool index`);

// DB-backed fetch that honors scanNotes' ?after=<leaf>&limit=<n> cursor.
const dbFetch = async (url) => {
  const after = Number(new URL(url, "http://x").searchParams.get("after") ?? -1);
  const limit = Number(new URL(url, "http://x").searchParams.get("limit") ?? 200);
  const items = allRows.filter((r) => r.leafIndex > after).slice(0, limit);
  return { ok: true, json: async () => ({ items }) };
};

// ── 4. Scan: which notes belong to THIS master? ─────────────────────────────
const notes = await scanNotes(viewingKey, { baseUrl: "db://commitments", fetch: dbFetch });
let total = 0n;
for (const n of notes) total += n.amount;

// Check spent status for each non-zero note against the on-chain nullifier set.
let unspent = 0n;
const unspentNotes = [];
for (const n of notes) {
  if (n.amount <= 0n) continue;
  const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex));
  let spent = false;
  try {
    const url = `${API}/api/shield/nullifier?coinType=${encodeURIComponent(USDSUI)}&nullifier=${nf.toString()}`;
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      spent = !!(j.spent && j.spent[nf.toString()]);
    } else {
      console.log(`  (nullifier API ${res.status} for leaf #${n.leafIndex} — cannot confirm spent)`);
    }
  } catch (e) {
    console.log(`  (nullifier check failed for leaf #${n.leafIndex}: ${e.message})`);
  }
  if (!spent) {
    unspent += n.amount;
    unspentNotes.push(n);
  }
}

console.log("\n=== RESULT (dry run — nothing moved) ===");
console.log(`notes owned by the recovered master: ${notes.length}`);
console.log(`gross (all owned notes, incl. spent): $${(Number(total) / 1e6).toFixed(2)}`);
console.log(`\nUNSPENT / recoverable notes: ${unspentNotes.length}`);
for (const n of unspentNotes) {
  console.log(`  leaf #${n.leafIndex}  $${(Number(n.amount) / 1e6).toFixed(2)} (${n.amount} micros)`);
}
console.log(`\n>>> RECOVERABLE FOR YOU: $${(Number(unspent) / 1e6).toFixed(2)} (${unspent} micros)`);
console.log(`(shared pool holds $10.00 total across all 12 pilot users — not all yours)`);
