import { SuinsClient } from "@mysten/suins";
import { SuiGrpcClient } from "@mysten/sui/grpc";
const c = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });
const s = new SuinsClient({ client: c, network: "mainnet" });
for (const name of ["zero.talise.sui", "eromonsele.talise.sui", "talise.talise.sui"]) {
  try {
    const r = await s.getNameRecord(name);
    console.log(name, "->", r ? `taken (target=${r.targetAddress})` : "FREE (null)");
  } catch (e) {
    console.log(name, "-> ERR:", e.message.slice(0,200));
  }
}
