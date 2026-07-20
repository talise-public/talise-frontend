// Smoke test: prove @waterx/sdk talks to WaterX perps on Sui MAINNET.
// Run from web/:  node scripts/waterx-smoke.mjs
import { PerpClient, getMarketData } from "@waterx/sdk/perp";

const MAINNET_CONFIG =
  "https://raw.githubusercontent.com/WaterXProtocol/waterx-config/main/mainnet.json";
const GRPC = process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";

const j = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2);

const main = async () => {
  console.log("creating PerpClient (MAINNET)…  grpc:", GRPC);
  const perp = await PerpClient.mainnet({ grpcUrl: GRPC, waterxConfigUrl: MAINNET_CONFIG });
  console.log("client ready. credit(USD) type:", perp.creditType());
  console.log("WLP type:", perp.wlpType());

  const tickers = ["BTCUSD", "ETHUSD", "SUIUSD", "TSLAXUSD"];
  for (const ticker of tickers) {
    try {
      const m = perp.getMarket(ticker);
      console.log(`\n=== ${ticker} ===  market=${m.market?.slice?.(0, 14) ?? "?"}…`);
      const data = await getMarketData(perp, { ticker });
      // print the decoded on-chain market view (prices, funding, OI, etc.)
      console.log(j(data));
    } catch (e) {
      console.log(`  ${ticker} FAILED: ${e?.message ?? e}`);
    }
  }
};

main().then(
  () => { console.log("\n✓ smoke OK — live WaterX mainnet data decoded"); process.exit(0); },
  (e) => { console.error("\n✗ smoke FAILED:", e?.stack ?? e); process.exit(1); },
);
