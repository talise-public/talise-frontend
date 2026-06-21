import { SuinsClient } from "@mysten/suins";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const sui = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" });
const suins = new SuinsClient({ client: sui as never, network: "mainnet" });

for (const n of [
  "nissinails.talise.sui",
  "nissi.talise.sui",
  "nissinails.sui",
]) {
  try {
    const rec = await suins.getNameRecord(n);
    console.log(`${rec?.targetAddress ? "✓" : "○"} ${n.padEnd(28)} → ${rec?.targetAddress ?? "(no target)"}`);
  } catch (e) {
    console.log(`✗ ${n.padEnd(28)} → ${(e as Error).message.slice(0, 70)}`);
  }
}
