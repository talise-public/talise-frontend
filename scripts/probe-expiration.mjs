import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

// get current epoch
const er = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"suix_getLatestSuiSystemState",params:[]}) });
const sys = (await er.json()).result;
const currentEpoch = Number(sys.epoch);
console.log("current epoch:", currentEpoch);

async function probe(label, exp, amount) {
  const tx = new Transaction(); tx.setSender(SENDER);
  tx.moveCall({ target:"0x2::balance::send_funds", typeArguments:[USDSUI], arguments:[tx.balance({ type: USDSUI, balance: BigInt(amount) }), tx.pure.address(RECIPIENT)] });
  tx.setGasPrice(0n); tx.setGasBudget(0n);
  if (exp) tx.setExpiration(exp);
  try { const bytes = await tx.build({ client }); const r = await fetch("https://fullnode.mainnet.sui.io:443", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"sui_dryRunTransactionBlock",params:[toBase64(bytes)]}) }); const j = await r.json(); console.log(`${label} status=${JSON.stringify(j.result?.effects?.status ?? j.error).slice(0,300)}`); }
  catch (e) { console.log(`${label} BUILD-ERR: ${e.message.slice(0,250)}`); }
}

// no expiration set
await probe("no-exp amount=100,000", null, 100_000n);
// Epoch variant
await probe(`Epoch=${currentEpoch+2}, amount=100,000`, { Epoch: String(currentEpoch+2) }, 100_000n);
// ValidDuring variant — full shape required
const validDuring = { ValidDuring: { minEpoch: null, maxEpoch: String(currentEpoch+2), minTimestamp: null, maxTimestamp: null, chain: "sui:mainnet", nonce: Math.floor(Math.random() * 4294967295) } };
await probe("ValidDuring amount=100,000", validDuring, 100_000n);
