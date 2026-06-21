import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

// Fetch current coins
const r0 = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getCoins",params:[SENDER, USDSUI, null, 50]}) });
const all = (await r0.json()).result.data;
console.log("getCoins returned", all.length, "entries");

const valid = [];
for (const c of all) {
  const ro = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_getObject",params:[c.coinObjectId, {showType:true}]}) });
  const jo = await ro.json();
  const okType = jo.result?.data?.type === `0x2::coin::Coin<${USDSUI}>`;
  console.log(`  ${c.coinObjectId.slice(0,18)}… bal=${c.balance} type=${jo.result?.data?.type ?? "NOT-FOUND"} valid=${okType}`);
  if (okType) valid.push(c);
}
console.log("\nvalid Coin objects:", valid.length);

// Build PTB as consolidate-prepare would
const tx = new Transaction();
tx.setSender(SENDER);
for (const c of valid) {
  const bal = tx.moveCall({ target:"0x2::coin::into_balance", typeArguments:[USDSUI], arguments:[tx.object(c.coinObjectId)] });
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[bal, tx.pure.address(SENDER)] });
}

// devInspect: doesn't need a gas coin, will show execution result
try {
  const bytes = await tx.build({ client, onlyTransactionKind: true });
  const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_devInspectTransactionBlock",params:[SENDER, toBase64(bytes)]}) });
  const j = await r.json();
  console.log("\ndevInspect status:", JSON.stringify(j.result?.effects?.status));
  console.log("error:", j.error ? JSON.stringify(j.error).slice(0,400) : "none");
  console.log("balanceChanges:", JSON.stringify(j.result?.balanceChanges));
} catch (e) { console.log("BUILD-ERR:", e.message.slice(0,400)); }
