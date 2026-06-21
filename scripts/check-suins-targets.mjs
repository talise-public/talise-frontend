import { SuinsClient } from "@mysten/suins";
import { SuiGrpcClient } from "@mysten/sui/grpc";
const c = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });
const s = new SuinsClient({ client: c, network: "mainnet" });
const ADMIN = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
for (const name of ["eromonsele.talise.sui", "emmanuel.talise.sui", "emma.talise.sui", "sele.talise.sui"]) {
  try {
    const rec = await s.getNameRecord(name);
    const target = rec?.targetAddress ?? "(null)";
    const matchesAdmin = target.toLowerCase() === ADMIN.toLowerCase();
    console.log(`${name}  target=${target.slice(0,18)}…  ${matchesAdmin ? "✓ ON ADMIN" : "✗ on " + target.slice(0,18) + "…"}`);
  } catch (e) {
    console.log(`${name}  ERR: ${e.message.slice(0,120)}`);
  }
}
