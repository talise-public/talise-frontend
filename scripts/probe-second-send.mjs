import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });
async function probe(label, amount) {
  const tx = new Transaction(); tx.setSender(SENDER);
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[tx.balance({ type: USDSUI, balance: BigInt(amount) }), tx.pure.address(RECIPIENT)] });
  tx.setGasPrice(0n); tx.setGasBudget(0n);
  try { const bytes = await tx.build({ client }); const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) }); const j = await r.json(); console.log(`${label} OK status=${JSON.stringify(j.result?.effects?.status ?? j.error)}`); }
  catch (e) { console.log(`${label} ERR: ${e.message.slice(0,250)}`); }
}
// remaining accumulator is 587,223 µ. Test various amounts.
await probe("amount=10,000  (min, leaves 577,223)", 10_000n);
await probe("amount=100,000 (leaves 487,223)    ", 100_000n);
await probe("amount=577,223 (leaves exactly 10k)", 577_223n);
await probe("amount=580,000 (leaves 7,223 <floor)", 580_000n);
await probe("amount=587,223 (entire balance)    ", 587_223n);
await probe("amount=587,224 (more than have)    ", 587_224n);
