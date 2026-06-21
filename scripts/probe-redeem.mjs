import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

async function probe(amount, opts = {}) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  const redeemed = tx.moveCall({
    target: "0x2::balance::redeem_funds",
    typeArguments: [USDSUI],
    arguments: [tx.withdrawal({ amount: BigInt(amount), type: USDSUI })],
  });
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [redeemed, tx.pure.address(RECIPIENT)],
  });
  tx.setGasPrice(0n);
  if (opts.budgetZero) tx.setGasBudget(0n);
  try {
    const bytes = await tx.build({ client });
    const r = await fetch("https://fullnode.mainnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"sui_dryRunTransactionBlock", params:[toBase64(bytes)] }),
    });
    const j = await r.json();
    console.log(`amount=${amount} budgetZero=${!!opts.budgetZero} status=${JSON.stringify(j.result?.effects?.status)} gas=${JSON.stringify(j.result?.effects?.gasUsed)}`);
    if (!j.result) console.log(`  err=${JSON.stringify(j.error).slice(0,300)}`);
  } catch (e) {
    console.log(`amount=${amount} budgetZero=${!!opts.budgetZero} BUILD-ERR ${e.message.slice(0,300)}`);
  }
}

// Also check what 0x57e5c3f... object is — likely the user's USDsui accumulator
async function objType(id) {
  const r = await fetch("https://fullnode.mainnet.sui.io:443", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_getObject",params:[id, {showType:true, showContent:true}]})
  });
  const j = await r.json();
  console.log(`obj ${id.slice(0,16)}… type=${j.result?.data?.type ?? "n/a"}`);
  if (j.result?.data?.content?.fields) console.log(`  fields=${JSON.stringify(j.result.data.content.fields).slice(0,300)}`);
}

await objType("0x57e5c3f2048a83d1b334647769b0e18dac1e5ffbad12bcced4e2244a757881be");
await probe(1, { budgetZero: true });
await probe(100, { budgetZero: true });
await probe(1000, { budgetZero: true });
await probe(3788, { budgetZero: true });
