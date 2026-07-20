import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const ANY_OWNED = "0x525d452aa4a8b1cf"; // need full ID
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

const r0 = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getOwnedObjects",params:[SENDER, { options: { showType: true } }, null, 1]}) });
const firstObj = (await r0.json()).result.data[0].data.objectId;
console.log("using owned object:", firstObj);

async function probe(label, amount) {
  const tx = new Transaction(); tx.setSender(SENDER);
  // add the owned object as a "no-op" input via tx.object — DOES NOT
  // consume; just references it so the validator sees an address-owned input
  tx.object(firstObj);
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[tx.balance({ type: USDSUI, balance: BigInt(amount) }), tx.pure.address(RECIPIENT)] });
  tx.setGasPrice(0n); tx.setGasBudget(0n);
  try { const bytes = await tx.build({ client }); const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) }); const j = await r.json(); console.log(`${label} status=${JSON.stringify(j.result?.effects?.status ?? j.error).slice(0,300)} gas=${JSON.stringify(j.result?.effects?.gasUsed)}`); }
  catch (e) { console.log(`${label} BUILD-ERR: ${e.message.slice(0,250)}`); }
}

await probe("with-owned-input amount=100,000", 100_000n);
await probe("with-owned-input amount=587,223 (full)", 587_223n);
