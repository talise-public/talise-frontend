import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

const r0 = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getOwnedObjects",params:[SENDER, { options: { showType: true } }, null, 1]}) });
const firstObj = (await r0.json()).result.data[0].data.objectId;
console.log("using owned object:", firstObj);

async function probe(label, build) {
  const tx = new Transaction(); tx.setSender(SENDER);
  build(tx);
  tx.setGasPrice(0n); tx.setGasBudget(0n);
  try { const bytes = await tx.build({ client }); const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) }); const j = await r.json(); console.log(`${label} status=${JSON.stringify(j.result?.effects?.status ?? j.error).slice(0,300)} gas=${JSON.stringify(j.result?.effects?.gasUsed)}`); }
  catch (e) { console.log(`${label} BUILD-ERR: ${e.message.slice(0,200)}`); }
}

// 1. transferObjects([obj], self) → meaningfully uses the object
await probe("transferObjects(obj, self) + send 100k", (tx) => {
  tx.transferObjects([tx.object(firstObj)], tx.pure.address(SENDER));
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[tx.balance({ type: USDSUI, balance: 100_000n }), tx.pure.address(RECIPIENT)] });
});

// 2. just transferObjects([obj], self) — no send, see if validator allows  
await probe("only transferObjects(obj, self) — gasless?", (tx) => {
  tx.transferObjects([tx.object(firstObj)], tx.pure.address(SENDER));
});
