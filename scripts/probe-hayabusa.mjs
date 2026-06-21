// Live check: does Hayabusa work as a drop-in Sui gRPC endpoint for
// @mysten/sui's SuiGrpcClient, and is it faster than the direct fullnode?
// Run: cd web && node scripts/probe-hayabusa.mjs
import { SuiGrpcClient } from "@mysten/sui/grpc";

const HAYABUSA =
  process.env.HAYABUSA_GRPC_URL ?? "https://hayabusa.mainnet.unconfirmed.cloud:443";
const DIRECT = "https://fullnode.mainnet.sui.io:443";

async function probe(label, url) {
  const c = new SuiGrpcClient({ network: "mainnet", baseUrl: url });
  const t0 = Date.now();
  try {
    const { chainIdentifier } = await c.core.getChainIdentifier();
    const t1 = Date.now();
    const gas = await c.getReferenceGasPrice();
    const t2 = Date.now();
    console.log(
      `${label} OK · chainId=${chainIdentifier} (${t1 - t0}ms) · gasPrice=${gas.referenceGasPrice} (${t2 - t1}ms) · total=${t2 - t0}ms`
    );
    return chainIdentifier;
  } catch (e) {
    console.log(`${label} ERR: ${String(e?.message ?? e).slice(0, 220)}`);
    return null;
  }
}

const h1 = await probe("[hayabusa  ]", HAYABUSA);
const d1 = await probe("[direct    ]", DIRECT);
const h2 = await probe("[hayabusa#2]", HAYABUSA); // warm cache
console.log(
  `\nchainId match: ${h1 && d1 ? (h1 === d1 ? "YES" : "NO (" + h1 + " vs " + d1 + ")") : "n/a"}`
);
