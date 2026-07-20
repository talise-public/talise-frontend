import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getCoins",params:[SENDER, USDSUI, null, 10]}) });
const coins = (await r.json()).result.data.filter(c => BigInt(c.balance) > 0n);
const anchor = coins.find(c => BigInt(c.balance) >= 100_000n);
console.log("anchor:", anchor.coinObjectId.slice(0,18), "bal=", anchor.balance);

async function probe(label, sendAmount) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  // Use ONLY the anchor coin (no accumulator). Split exactly sendAmount.
  const sourceCoin = tx.object(anchor.coinObjectId);
  const [sendCoin] = tx.splitCoins(sourceCoin, [BigInt(sendAmount)]);
  // Use balance::redeem_funds equivalent via coin::into_balance
  const bal = tx.moveCall({ target:"0x2::coin::into_balance", typeArguments:[USDSUI], arguments:[sendCoin] });
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[bal, tx.pure.address(RECIPIENT)] });
  tx.setGasPrice(0n); tx.setGasBudget(0n);
  try {
    const bytes = await tx.build({ client });
    const dr = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) });
    const j = await dr.json();
    console.log(`${label} BUILD OK status=${JSON.stringify(j.result?.effects?.status ?? j.error)} gas=${JSON.stringify(j.result?.effects?.gasUsed)}`);
  } catch (e) { console.log(`${label} ERR: ${e.message.slice(0,250)}`); }
}

await probe("manual splitCoins(coin, amount)+into_balance+send_funds, 0.10", 100_000n);
