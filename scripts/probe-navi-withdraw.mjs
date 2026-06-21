import { NaviAdapter } from "@t2000/sdk";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const client = new SuiJsonRpcClient({ url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });
const a = new NaviAdapter();
await a.init(client);
console.log("init OK");
try {
  const p = await a.getPositions(SENDER);
  console.log("supplies:", JSON.stringify(p.supplies?.map(s => ({ asset: s.asset, amount: s.amount })) ?? []));
} catch (e) { console.log("getPositions ERR:", e.message); }
