// Verify ValidDuring expiration unblocks gasless USDsui send when the
// PTB has no address-owned input. Mirrors the SDK's own parallel
// executor addressBalance gas mode (parallel.mjs#getValidDuringExpiration).
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });

// 1) Read chain identifier + current epoch the same way the SDK does.
const { chainIdentifier } = await client.core.getChainIdentifier();
console.log("chainIdentifier:", chainIdentifier);

const sysR = await fetch("https://fullnode.mainnet.sui.io:443", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getLatestSuiSystemState", params: [] }),
});
const currentEpoch = BigInt((await sysR.json()).result.epoch);
console.log("currentEpoch:", currentEpoch.toString());

async function probe(label, amount) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [
      tx.balance({ type: USDSUI, balance: BigInt(amount) }),
      tx.pure.address(RECIPIENT),
    ],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(currentEpoch),
      maxEpoch: String(currentEpoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: (Math.random() * 4294967296) >>> 0,
    },
  });
  try {
    const bytes = await tx.build({ client });
    const r = await fetch("https://fullnode.mainnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_dryRunTransactionBlock",
        params: [toBase64(bytes)],
      }),
    });
    const j = await r.json();
    console.log(
      `${label} BUILD OK · dryRun.status=${JSON.stringify(j.result?.effects?.status ?? j.error).slice(0, 300)}`
    );
  } catch (e) {
    console.log(`${label} BUILD-ERR: ${e.message.slice(0, 300)}`);
  }
}

await probe("amount=100,000 (0.10 USDsui)", 100_000n);
await probe("amount=10,000 (0.01 USDsui)", 10_000n);

// Try the legacy Epoch variant — simpler, older, might be on the
// gRPC allowlist even when ValidDuring isn't.
async function probeEpoch(label, amount) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [
      tx.balance({ type: USDSUI, balance: BigInt(amount) }),
      tx.pure.address(RECIPIENT),
    ],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  tx.setExpiration({ Epoch: String(currentEpoch + 1n) });
  try {
    const bytes = await tx.build({ client });
    const r = await fetch("https://fullnode.mainnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_dryRunTransactionBlock",
        params: [toBase64(bytes)],
      }),
    });
    const j = await r.json();
    console.log(
      `${label} BUILD OK · dryRun.status=${JSON.stringify(j.result?.effects?.status ?? j.error).slice(0, 300)}`
    );
  } catch (e) {
    console.log(`${label} BUILD-ERR: ${e.message.slice(0, 300)}`);
  }
}

await probeEpoch("[Epoch] amount=100,000 (0.10 USDsui)", 100_000n);

// Try using the JSON-RPC client for build (might encode ValidDuring
// correctly even if gRPC does not).
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
const jsonClient = new SuiJsonRpcClient({ network: "mainnet", url: "https://fullnode.mainnet.sui.io:443" });
async function probeJsonRpc(label, amount) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [
      tx.balance({ type: USDSUI, balance: BigInt(amount) }),
      tx.pure.address(RECIPIENT),
    ],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(currentEpoch),
      maxEpoch: String(currentEpoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: (Math.random() * 4294967296) >>> 0,
    },
  });
  try {
    const bytes = await tx.build({ client: jsonClient });
    const r = await fetch("https://fullnode.mainnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_dryRunTransactionBlock",
        params: [toBase64(bytes)],
      }),
    });
    const j = await r.json();
    console.log(
      `${label} BUILD OK · dryRun.status=${JSON.stringify(j.result?.effects?.status ?? j.error).slice(0, 300)}`
    );
  } catch (e) {
    console.log(`${label} BUILD-ERR: ${e.message.slice(0, 300)}`);
  }
}

await probeJsonRpc("[ValidDuring via JSON-RPC build] amount=100,000", 100_000n);

// Build via JSON-RPC, then check whether gRPC simulateTransaction
// accepts the SAME bytes. If gRPC simulate rejects, gRPC execute will
// likely too — and we'd need to route execute through JSON-RPC.
async function probeGrpcSimulateAfterJsonBuild(label, amount) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [
      tx.balance({ type: USDSUI, balance: BigInt(amount) }),
      tx.pure.address(RECIPIENT),
    ],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(currentEpoch),
      maxEpoch: String(currentEpoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: (Math.random() * 4294967296) >>> 0,
    },
  });
  try {
    const bytes = await tx.build({ client: jsonClient });
    try {
      const sim = await client.simulateTransaction({ transaction: bytes });
      console.log(`${label} GRPC-SIM OK · ${JSON.stringify(sim).slice(0, 300)}`);
    } catch (e) {
      console.log(`${label} GRPC-SIM-ERR: ${e.message.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`${label} BUILD-ERR: ${e.message.slice(0, 300)}`);
  }
}

await probeGrpcSimulateAfterJsonBuild("[JSON build → gRPC sim] amount=100,000", 100_000n);
