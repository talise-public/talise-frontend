// Does Hayabusa actually support executeTransaction (a WRITE) the way the
// direct fullnode does? The gasless send broadcasts via sui().executeTransaction
// which now hits Hayabusa first. Prior probes only tested READS. Here we send a
// deliberately-INVALID tx to both and compare the error shape:
//   - direct fullnode understands the method -> INVALID_ARGUMENT / tx decode error
//   - if Hayabusa can't proxy writes -> UNIMPLEMENTED / transport / cached-empty
// Run: cd web && node scripts/probe-hayabusa-execute.mjs
import { SuiGrpcClient } from "@mysten/sui/grpc";

const H = "https://hayabusa.mainnet.unconfirmed.cloud:443";
const D = "https://fullnode.mainnet.sui.io:443";

// Garbage but well-formed-ish inputs: a few bytes as the "transaction" and a
// dummy signature. Neither node should ACCEPT this; the question is HOW each
// rejects it (method understood vs not).
const badTx = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const badSig = "AA=="; // base64 nonsense

async function run(label, url) {
  const c = new SuiGrpcClient({ network: "mainnet", baseUrl: url });
  const t0 = Date.now();
  try {
    const r = await c.executeTransaction({ transaction: badTx, signatures: [badSig] });
    console.log(`${label} executeTransaction: UNEXPECTED OK (${Date.now() - t0}ms) ${JSON.stringify(r).slice(0, 120)}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const code = e?.code ?? e?.cause?.code ?? "";
    console.log(`${label} executeTransaction: ERR (${Date.now() - t0}ms) code=${code} :: ${msg.slice(0, 220)}`);
  }
}

await run("[HAYABUSA]", H);
await run("[DIRECT  ]", D);
