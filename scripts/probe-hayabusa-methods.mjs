// Which gRPC methods actually work through Hayabusa vs the direct fullnode?
// Diagnoses the "balance/suins/history blank" report. Run: cd web && node scripts/probe-hayabusa-methods.mjs
import { SuiGrpcClient } from "@mysten/sui/grpc";

const H = "https://hayabusa.mainnet.unconfirmed.cloud:443";
const D = "https://fullnode.mainnet.sui.io:443";
const ADDR = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const USDSUI =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

async function run(label, url) {
  const c = new SuiGrpcClient({ network: "mainnet", baseUrl: url });
  const tests = {
    "core.chainId": () => c.core.getChainIdentifier(),
    gasPrice: () => c.getReferenceGasPrice(),
    getBalance: () => c.getBalance({ owner: ADDR, coinType: USDSUI }),
    listOwnedObjects: () => c.listOwnedObjects({ owner: ADDR }),
    listBalances: () => c.listBalances({ owner: ADDR }),
  };
  for (const [name, fn] of Object.entries(tests)) {
    const t0 = Date.now();
    try {
      const r = await fn();
      console.log(`${label} ${name}: OK (${Date.now() - t0}ms) ${JSON.stringify(r).slice(0, 90)}`);
    } catch (e) {
      console.log(`${label} ${name}: ERR ${String(e?.message ?? e).slice(0, 180)}`);
    }
  }
}

await run("[HAYABUSA]", H);
console.log("");
await run("[DIRECT  ]", D);
