import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getCoins",params:[SENDER, USDSUI, null, 10]}) });
const coins = (await r.json()).result.data.filter(c => BigInt(c.balance) > 0n);
console.log("coins:", coins.map(c => ({id: c.coinObjectId.slice(0,18), bal: c.balance})));

async function probe(amount) {
  const c = coins.find(x => BigInt(x.balance) >= BigInt(amount));
  if (!c) { console.log(`amount=${amount} NO SUITABLE COIN`); return; }
  const tx = new Transaction();
  tx.setSender(SENDER);
  const [split] = tx.splitCoins(tx.object(c.coinObjectId), [BigInt(amount)]);
  const bal = tx.moveCall({ target:"0x2::coin::into_balance", typeArguments:[USDSUI], arguments:[split] });
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[bal, tx.pure.address(RECIPIENT)] });
  tx.setGasPrice(0n); tx.setGasBudget(0n);
  try {
    const bytes = await tx.build({ client });
    const dr = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) });
    const j = await dr.json();
    console.log(`amount=${amount} via coin ${c.coinObjectId.slice(0,18)} BUILD OK status=${JSON.stringify(j.result?.effects?.status)} gas=${JSON.stringify(j.result?.effects?.gasUsed)}`);
  } catch (e) { console.log(`amount=${amount} ERR: ${e.message.slice(0,250)}`); }
}

await probe(10_000n);   // 0.01 USDsui
await probe(100_000n);  // 0.10 USDsui — the failing case
await probe(500_000n);  // 0.5 USDsui
