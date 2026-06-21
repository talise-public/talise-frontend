import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

// Fetch coins + balance
const balsR = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getAllBalances",params:[SENDER]}) });
const usdsui = (await balsR.json()).result.find(b => b.coinType.includes("usdsui"));
const accumulator = BigInt(usdsui.fundsInAddressBalance ?? "0");
console.log("accumulator (fundsInAddressBalance):", accumulator.toString());

const coinsR = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getCoins",params:[SENDER, USDSUI, null, 50]}) });
const all = (await coinsR.json()).result.data;

// FILTER: drop any coin whose balance exactly matches the accumulator amount
// AND whose version is dramatically older than the others (heuristic for the shadow)
const versions = all.map(c => BigInt(c.version));
const maxVersion = versions.reduce((a, b) => a > b ? a : b);
const filtered = all.filter(c => {
  const bal = BigInt(c.balance);
  const ver = BigInt(c.version);
  const isShadow = bal === accumulator && (maxVersion - ver) > 1_000_000n;
  if (isShadow) console.log(`SKIP shadow: ${c.coinObjectId.slice(0,18)}… bal=${c.balance} ver=${c.version}`);
  return !isShadow;
});
console.log("kept", filtered.length, "real Coin<USDsui> objects out of", all.length);

const tx = new Transaction();
tx.setSender(SENDER);
for (const c of filtered) {
  const bal = tx.moveCall({ target:"0x2::coin::into_balance", typeArguments:[USDSUI], arguments:[tx.object(c.coinObjectId)] });
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[bal, tx.pure.address(SENDER)] });
}
try {
  const bytes = await tx.build({ client, onlyTransactionKind: true });
  const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_devInspectTransactionBlock",params:[SENDER, toBase64(bytes)]}) });
  const j = await r.json();
  console.log("devInspect status:", JSON.stringify(j.result?.effects?.status));
  console.log("balanceChanges:", JSON.stringify(j.result?.balanceChanges));
} catch (e) { console.log("BUILD-ERR:", e.message.slice(0,300)); }
