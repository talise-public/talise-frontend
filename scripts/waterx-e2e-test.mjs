// Build + simulate every WaterX tx (perps + prediction) against a real mainnet
// account. No signing — proves the integration would execute on-chain.
import {
  PerpClient, getMarketData, getSpendableCreditBalance, getAccountPositions,
  buildPlaceOrderTx, buildClosePositionTx, rawPrice,
} from "@waterx/sdk/perp";
import { mintCreditToAccount, routeNative, requestCreditWithdraw, enqueueWithdrawal } from "@waterx/sdk/account";
import * as predict from "@waterx/sdk/prediction";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

const CFG = "https://raw.githubusercontent.com/WaterXProtocol/waterx-config/main/mainnet.json";
const GRPC = "https://fullnode.mainnet.sui.io:443";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const ADDR = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const ACCT = "0xb9fe0331ae7d28b3dcdf46db35a60412cb0a61855f61fafa59fba13f349d4cf8";
const G = "\x1b[32m✓\x1b[0m", R = "\x1b[31m✗\x1b[0m";

async function sim(client, label, txp) {
  try {
    const tx = await txp; tx.setSender(ADDR);
    const r = await client.simulate(tx);
    if (r?.$kind === "FailedTransaction") {
      const cmd = (r.commandResults || []).map(c => c?.error).filter(Boolean)[0];
      const err = r.FailedTransaction?.status?.error?.message || r.FailedTransaction?.error || cmd || "?";
      console.log(R, label, "—", typeof err === "string" ? err.slice(0, 120) : JSON.stringify(err).slice(0, 120));
    } else console.log(G, label, "— builds + simulates OK");
  } catch (e) { console.log(R, label, "— THREW:", (e?.message ?? e).slice(0, 120)); }
}

const perp = await PerpClient.mainnet({ grpcUrl: GRPC, waterxConfigUrl: CFG, cache: true });
const pc = await predict.PredictClient.mainnet({ grpcUrl: GRPC, waterxConfigUrl: CFG });
const px = Number((await getMarketData(perp, { ticker: "SUIUSD" })).long_avg_entry_price) / 1e9;

console.log("\n── PERPS: reads ──");
try { await getMarketData(perp, { ticker: "BTCUSD" }); console.log(G, "getMarketData"); } catch (e) { console.log(R, "getMarketData", e.message); }
try { const b = await getSpendableCreditBalance(perp, ACCT); console.log(G, `spendable balance $${(Number(b.totalRaw) / 1e6).toFixed(2)}`); } catch (e) { console.log(R, "balance", e.message); }
let perpPos = [];
try {
  for (const t of ["SUIUSD", "BTCUSD", "ETHUSD"]) {
    const mk = await getMarketData(perp, { ticker: t });
    const ps = await getAccountPositions(perp, { ticker: t, accountObjectAddress: ACCT, basePriceUsd: rawPrice(Number(mk.long_avg_entry_price) / 1e9), collateralPriceUsd: rawPrice(1) });
    ps.forEach(p => perpPos.push({ t, id: String(p.position_id), long: p.is_long }));
  }
  console.log(G, `positions read (${perpPos.length} open)`);
} catch (e) { console.log(R, "positions", e.message); }

console.log("\n── PERPS: build + simulate ──");
await sim(perp, "deposit $0.4 USDsui", (async () => { const tx = new Transaction(); const c = tx.add(coinWithBalance({ type: USDSUI, balance: 400_000n })); mintCreditToAccount(perp, tx, { accountId: ACCT, assetCoin: c, assetType: USDSUI }); return tx; })());
await sim(perp, "open SUI long ($3.5 coll)", buildPlaceOrderTx(perp, { ticker: "SUIUSD", accountId: ACCT, collateralType: perp.creditType(), main: { isLong: true, isStopOrder: false, reduceOnly: false, size: rawPrice(4), acceptablePrice: rawPrice(px * 1.02), collateralAmount: 3_500_000n }, preOrders: [] }));
await sim(perp, "open SUI long + TP/SL", buildPlaceOrderTx(perp, { ticker: "SUIUSD", accountId: ACCT, collateralType: perp.creditType(), main: { isLong: true, isStopOrder: false, reduceOnly: false, size: rawPrice(4), acceptablePrice: rawPrice(px * 1.02), collateralAmount: 3_500_000n }, preOrders: [{ isLong: false, isStopOrder: true, reduceOnly: true, size: rawPrice(4), triggerPrice: rawPrice(px * 1.1), collateralAmount: 0n }, { isLong: false, isStopOrder: true, reduceOnly: true, size: rawPrice(4), triggerPrice: rawPrice(px * 0.9), collateralAmount: 0n }] }));
if (perpPos[0]) await sim(perp, `close ${perpPos[0].t} #${perpPos[0].id}`, buildClosePositionTx(perp, { ticker: perpPos[0].t, accountId: ACCT, collateralType: perp.creditType(), positionId: BigInt(perpPos[0].id), acceptablePrice: rawPrice(perpPos[0].long ? px * 0.97 : px * 1.03) }));
else console.log("  (no open perp position to close-test)");
await sim(perp, "withdraw $1 → USDsui", (async () => { const tx = new Transaction(); const route = routeNative(perp, tx, { assetType: USDSUI, minOutput: 0 }); const req = requestCreditWithdraw(perp, tx, { accountId: ACCT, amount: 1_000_000n, recipient: ADDR, route }); enqueueWithdrawal(perp, tx, { withdrawRequest: req }); return tx; })());

console.log("\n── PREDICTION ──");
let mkts = [];
try { mkts = await predict.getUnresolvedMarkets(pc); console.log(G, `getUnresolvedMarkets (${mkts.length})`); } catch (e) { console.log(R, "markets", e.message); }
let predPos = [];
try {
  for (const m of mkts.slice(0, 12)) { const ids = await predict.getAccountPositionIdsByMarketId(pc, { accountId: ACCT, marketId: m.marketIdHex }); ids.forEach(id => predPos.push({ id: String(id), mk: m.marketIdHex })); }
  console.log(G, `positions read (${predPos.length})`);
} catch (e) { console.log(R, "pred positions", e.message); }
const m = mkts.find(x => Number(x.yesShares) > 0) ?? mkts[0];
const price = Number(m.yesCost) / Number(m.yesShares), cap = Math.min(9900, Math.round(price * 10000) + 500);
await sim(pc, `bet $1 YES on #${m.marketKey}`, predict.buildPlaceOrderTx(perp, pc, { accountId: ACCT, marketId: m.marketIdHex, selection: "YES", maxSpend: 1_000_000n, minShares: (1_000_000n * 10000n) / BigInt(cap), priceCapBps: cap, expiryTs: 1900000000000, consolidateToUsd: true }));
if (predPos[0]) await sim(pc, `claim #${predPos[0].id}`, predict.buildBatchClaimTx(perp, pc, { accountId: ACCT, positionIds: [BigInt(predPos[0].id)] }));
else console.log("  (no prediction position to claim-test)");
console.log("\ndone.");
process.exit(0);
