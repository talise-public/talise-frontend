// One-shot: split the relayer's USDsui coin into an EXACT $10 deposit coin +
// remainder, both owned by the relayer. Signed with SHIELD_RELAYER_SK.
// Prints DEPOSIT_COIN_ID ($10) + the remainder coin id (ZERO_COIN_SOURCE_ID).
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
const { sui } = await import("../lib/sui.ts");

const COIN_TYPE =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
// Parameterized: SPLIT_SK (owner key) + SPLIT_AMOUNT (micros). Sources an exact
// coin via coinWithBalance (version-robust — merges/splits the wallet's coins at
// build time), avoiding stale specific-coin-id resolution.
const AMOUNT = BigInt(process.env.SPLIT_AMOUNT || 10_000_000);

const sk = process.env.SPLIT_SK || process.env.SHIELD_RELAYER_SK;
if (!sk) throw new Error("SPLIT_SK (or SHIELD_RELAYER_SK) missing");
const kp = Ed25519Keypair.fromSecretKey(sk);
const addr = kp.toSuiAddress();
console.log("relayer", addr);

const RPC = "https://fullnode.mainnet.sui.io:443";
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
// Pin owned-object refs via JSON-RPC (grpc resolution is flaky from here).
function jsonRpcResolutionPlugin() {
  return async (td, _o, next) => {
    const ids = new Set();
    for (const inp of td.inputs)
      if (inp.$kind === "UnresolvedObject" && inp.UnresolvedObject?.objectId)
        ids.add(inp.UnresolvedObject.objectId);
    if (ids.size) {
      const objs = await rpc("sui_multiGetObjects", [[...ids], { showOwner: true }]);
      const by = new Map();
      for (const o of objs)
        if (o?.data) by.set(o.data.objectId, { version: String(o.data.version), digest: o.data.digest });
      for (const inp of td.inputs) {
        if (inp.$kind !== "UnresolvedObject") continue;
        const info = by.get(inp.UnresolvedObject.objectId);
        if (!info) throw new Error(`object not found: ${inp.UnresolvedObject.objectId}`);
        const id = inp.UnresolvedObject.objectId;
        delete inp.UnresolvedObject;
        inp.$kind = "Object";
        inp.Object = { $kind: "ImmOrOwnedObject", ImmOrOwnedObject: { objectId: id, version: info.version, digest: info.digest } };
      }
    }
    await next();
  };
}
const { toBase64 } = await import("@mysten/sui/utils");
const client = sui();
const tx = new Transaction();
tx.setSender(addr);
tx.setGasBudget(20_000_000n);
// Source an EXACT-amount coin from the wallet's USDsui (never the gas coin) and
// keep it owned by the wallet — it becomes DEPOSIT_COIN_ID.
const coin = tx.add(coinWithBalance({ type: COIN_TYPE, balance: AMOUNT, useGasCoin: false }));
tx.transferObjects([coin], addr);

// Build with the gRPC client (resolves coinWithBalance + gas), SUBMIT via JSON-RPC.
const built = await tx.build({ client });
const { signature } = await kp.signTransaction(built);
const res = await rpc("sui_executeTransactionBlock", [
  toBase64(built),
  [signature],
  { showEffects: true },
  "WaitForLocalExecution",
]);
console.log("split digest:", res?.digest, res?.effects?.status?.status, res?.effects?.status?.error ?? "");

// Enumerate wallet USDsui coins post-split (via JSON-RPC).
const coinsRes = await rpc("suix_getCoins", [addr, COIN_TYPE]);
console.log("\nwallet USDsui coins after split:");
let exact, rem;
for (const c of coinsRes.data) {
  const v = BigInt(c.balance);
  const tag = v === AMOUNT ? `  <- DEPOSIT_COIN_ID (exact)` : (v > 0n ? "  <- ZERO_COIN_SOURCE_ID (remainder)" : "");
  console.log(" ", c.coinObjectId, Number(v) / 1e6, "USDsui", tag);
  if (v === AMOUNT && !exact) exact = c.coinObjectId;
  else if (v > 0n) rem = c.coinObjectId;
}
console.log("\nDEPOSIT_COIN_ID=" + exact);
console.log("ZERO_COIN_SOURCE_ID=" + rem);
