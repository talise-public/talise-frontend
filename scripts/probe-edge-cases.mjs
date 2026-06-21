import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

async function probe(label, amount) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [tx.balance({ type: USDSUI, balance: BigInt(amount) }), tx.pure.address(RECIPIENT)],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  try {
    const bytes = await tx.build({ client });
    const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) });
    const j = await r.json();
    console.log(`${label} BUILD OK bytes=${bytes.length} dryRun.status=${JSON.stringify(j.result?.effects?.status ?? j.error)}`);
  } catch (e) { console.log(`${label} BUILD-ERR: ${e.message.slice(0,250)}`); }
}

// edge cases
await probe("[user balance: 670,716] amount=670,716 (exact full)", 670_716n);
await probe("[amount=670,000 (close to full, leaves 716µ)]       ", 670_000n);
await probe("[amount=660,716 (leaves exactly 10,000µ)]           ", 660_716n);
await probe("[amount=10,000 (the minimum)]                       ", 10_000n);
await probe("[amount=9,999 (below minimum)]                      ", 9_999n);
await probe("[amount=1,000,000 (more than user has)]             ", 1_000_000n);
