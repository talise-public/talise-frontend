// One-shot: publish talise_profile to mainnet over JSON-RPC (the sui CLI's gRPC
// read path is broken on this machine, so we build+sign+submit ourselves — the
// same pattern as shield-mainnet-lifecycle.mjs). Reads the compiled bytecode +
// the exported publisher key from the scratchpad. Prints PACKAGE_ID.
import { readFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toBase64 } from "@mysten/sui/utils";

const SCR =
  "/private/tmp/claude-501/-Users-eromonseleodigie-Talise/15fc1e87-b74f-4a4e-b549-a757a2afe2fb/scratchpad";
const RPC = "https://fullnode.mainnet.sui.io:443";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const bc = JSON.parse(readFileSync(`${SCR}/profile-bytecode.json`, "utf8"));
const sk = readFileSync(`${SCR}/pub.key`, "utf8").trim();
const kp = Ed25519Keypair.fromSecretKey(sk);
const sender = kp.toSuiAddress();
console.log("publisher:", sender);

// Gas: pick the largest SUI coin, pin its ref, set price explicitly so the tx
// builds fully offline (publish has no object inputs to resolve).
const coins = await rpc("suix_getCoins", [sender, "0x2::sui::SUI"]);
const gas = coins.data.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0];
if (!gas) throw new Error("no gas coin");
const gasPrice = await rpc("suix_getReferenceGasPrice", []);
console.log("gas coin:", gas.coinObjectId, "bal", Number(gas.balance) / 1e9, "SUI | price", gasPrice);

const tx = new Transaction();
tx.setSender(sender);
tx.setGasBudget(300_000_000n);
tx.setGasPrice(BigInt(gasPrice));
tx.setGasPayment([
  { objectId: gas.coinObjectId, version: gas.version, digest: gas.digest },
]);
const [cap] = tx.publish({ modules: bc.modules, dependencies: bc.dependencies });
tx.transferObjects([cap], sender);

const built = await tx.build();
const { signature } = await kp.signTransaction(built);
const res = await rpc("sui_executeTransactionBlock", [
  toBase64(built),
  [signature],
  { showEffects: true, showObjectChanges: true },
  "WaitForLocalExecution",
]);

console.log("digest:", res.digest, "status:", res.effects?.status?.status, res.effects?.status?.error ?? "");
for (const c of res.objectChanges ?? []) {
  if (c.type === "published") console.log("PACKAGE_ID:", c.packageId);
  if (String(c.objectType || "").includes("UpgradeCap")) console.log("UPGRADE_CAP:", c.objectId);
}
