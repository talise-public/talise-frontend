/**
 * INDEPENDENT verifier for a Talise shielded-pool disclosure receipt.
 *
 * This is the trust-minimising path. It talks to a Sui fullnode of YOUR
 * choosing and to nothing else — no Talise endpoint is contacted, no Talise
 * signature is checked, no trusted-setup artefact is loaded. If it says a
 * receipt checks out, that is because the chain says so.
 *
 * Usage:
 *   node --loader ./scripts/shield-node-loader.mjs \
 *        scripts/verify-shield-disclosure.mjs <receipt.json> [options]
 *
 *   cat receipt.json | node --loader ./scripts/shield-node-loader.mjs \
 *        scripts/verify-shield-disclosure.mjs -
 *
 * Options:
 *   --fullnode <url>   JSON-RPC fullnode to consult.
 *                      Default https://fullnode.mainnet.sui.io
 *   --owner <pubkey>   Decimal owner pubkey every note must be addressed to.
 *                      WITHOUT it a receipt proves only that a note of that
 *                      amount exists — the PAYER also knows the blinding, so a
 *                      payer can open a note they created for themselves. If you
 *                      are the payee, pass YOUR pubkey.
 *   --offline          Skip the chain anchor. Checks only that the revealed
 *                      preimages hash to the claimed commitments. NEVER
 *                      sufficient on its own — a forger can invent a
 *                      self-consistent note. Use it to lint a receipt you are
 *                      about to SEND, not one you have RECEIVED.
 *   --json             Emit the raw verification result as JSON.
 *
 * Exit code 0 iff every opening verified against the chain.
 *
 * What a passing receipt proves, and what it does not, is printed with the
 * result and documented in web/lib/shield/DISCLOSURE.md.
 */

import { readFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const VALUE_FLAGS = new Set(["--fullnode", "--owner"]);
const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  // Drop values consumed by a value-taking flag.
  return !(i > 0 && VALUE_FLAGS.has(argv[i - 1]));
});

if (positional.length === 0 || flag("help")) {
  console.error(
    "usage: verify-shield-disclosure.mjs <receipt.json|-> [--fullnode <url>] " +
      "[--owner <pubkey>] [--offline] [--json]"
  );
  process.exit(2);
}

const source = positional[0];
let text;
try {
  text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
} catch (e) {
  console.error(`cannot read ${source}: ${e.message}`);
  process.exit(2);
}

let receipt;
try {
  receipt = JSON.parse(text);
} catch (e) {
  console.error(`not valid JSON: ${e.message}`);
  process.exit(2);
}

const { verifyDisclosureReceipt, DEFAULT_FULLNODE_URL } = await import(
  "../lib/shield/disclosure/verify.ts"
);

const fullnodeUrl = opt("fullnode", DEFAULT_FULLNODE_URL);
const offlineOnly = flag("offline");
const expectedOwnerPubkey = opt("owner", undefined);

const result = await verifyDisclosureReceipt(receipt, {
  fullnodeUrl,
  offlineOnly,
  expectedOwnerPubkey,
});

if (flag("json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const tick = (ok) => (ok ? "PASS" : "FAIL");

console.log("");
console.log("Talise shielded-pool disclosure — independent verification");
console.log("─".repeat(72));
console.log(`receipt digest : ${result.receiptDigest ?? "(uncomputable)"}`);
console.log(`receipt id     : ${result.receiptId ?? "(none)"}`);
console.log(
  `issued         : ${result.issuedAtMs ? new Date(result.issuedAtMs).toISOString() : "(none)"}`
);
console.log(`fullnode       : ${result.fullnodeUrl ?? "(offline, no chain anchor)"}`);
console.log(`openings       : ${result.openings.length}`);
console.log("");

for (const [err] of result.errors.map((e) => [e])) {
  console.log(`  receipt error: ${err}`);
}

result.openings.forEach((o, i) => {
  console.log(`[${i}] ${tick(o.ok)}  commitment ${o.commitment}`);
  console.log(`     opening (offline) : ${tick(o.local.ok)}`);
  for (const e of o.local.errors) console.log(`       - ${e}`);
  console.log(`     chain anchor      : ${o.chain.status} — ${o.chain.detail}`);
  console.log(`     pool binding      : ${o.chain.poolBinding}`);
  console.log(`     addressed to      : ${o.owner.status} — ${o.owner.detail}`);
  // Label it as the receipt's CLAIM, not a finding, so a failing opening's
  // sentence can never be read as something the verifier stands behind.
  if (o.statement) {
    console.log(`     ${o.ok ? "verified claim    " : "claim (UNVERIFIED)"}: ${o.statement}`);
  }
  console.log("");
});

console.log("─".repeat(72));
console.log(result.ok ? "RESULT: VERIFIED" : "RESULT: NOT VERIFIED");
console.log("");
if (result.ok) {
  console.log("Proves:");
  for (const p of result.proves) console.log(`  • ${p}`);
  console.log("");
}
console.log("Does NOT prove:");
for (const d of result.doesNotProve) console.log(`  • ${d}`);
console.log("");
if (offlineOnly) {
  console.log(
    "WARNING: --offline was used. The commitments were NOT looked up on chain, so\n" +
      "this run cannot distinguish a real note from an invented one. Re-run without\n" +
      "--offline before relying on the result."
  );
  console.log("");
}

process.exit(result.ok ? 0 : 1);
