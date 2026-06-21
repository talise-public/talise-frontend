import { SuinsClient } from "@mysten/suins";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const sui = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl("mainnet"),
  network: "mainnet",
});
const suins = new SuinsClient({ client: sui as never, network: "mainnet" });

const candidates = [
  "mysten.sui",
  "suins.sui",
  "mahi.sui",
  "alice.sui",
  "vitalik.sui",
  "eromonsele.sui",
  "eromonsele.talise.sui",
  "jude.talise.sui",
];

for (const name of candidates) {
  try {
    const rec = await suins.getNameRecord(name);
    console.log(
      `${rec?.targetAddress ? "✓" : "○"} ${name.padEnd(28)} → ${rec?.targetAddress ?? "(no target)"}`
    );
  } catch (e) {
    console.log(`✗ ${name.padEnd(28)} → ${(e as Error).message.slice(0, 70)}`);
  }
}
