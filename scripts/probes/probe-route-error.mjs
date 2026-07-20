import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });
const tx = new Transaction();
tx.setSender(SENDER);
const redeemed = tx.moveCall({ target:"0x2::balance::redeem_funds", typeArguments:[USDSUI], arguments:[tx.withdrawal({amount:1000n, type:USDSUI})] });
tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[redeemed, tx.pure.address(RECIPIENT)] });
tx.setGasPrice(0n);
tx.setGasBudget(0n);
try {
  await tx.build({ client });
  console.log("BUILD SUCCESS (unexpected)");
} catch (err) {
  const msg = String(err.message);
  console.log("err.message:", msg);
  console.log("");
  console.log("=== REGEX TESTS ===");
  console.log("/withdraw reservation/i:", /withdraw reservation/i.test(msg));
  console.log("/accumulator/i:        ", /accumulator/i.test(msg));
  console.log("/InsufficientGas/i:    ", /InsufficientGas/i.test(msg));
  console.log("/insufficient.*balance/i:", /insufficient.*balance/i.test(msg));
}
