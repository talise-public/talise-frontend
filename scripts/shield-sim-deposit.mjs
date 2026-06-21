// Simulate the shielded DEPOSIT transact PTB on mainnet via devInspect.
// Uses a REAL Groth16 proof from the Rust prover bound to the LIVE pool + LIVE empty root.
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { toBase64 } from "@mysten/sui/utils";

const RPC = "https://fullnode.mainnet.sui.io:443";
const PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
const POOL = "0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1";
const COIN_TYPE = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const RELAYER = "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
// A real USDsui coin object on mainnet (0.20 USDsui), used as the deposit-coin source.
const USDSUI_COIN = "0x8a1c28a71ddfb123581eef0325c42212f3ce4161a4fc06b1702914c777ad4b27";
const COIN_OWNER = "0x39d4ded1f081c828662dcbf4a43c9183c9e10510112e269d961cf89c90b1ae7b";

// ---- REAL proof (amount 200000, pool-bound, live empty root) ----
const proofHex =
  "6cf350feaf23c93c465aea1ea2712bce059e96dfe27b5f84f746dc1f9280820b952c822ce307395140ccfd29c19ebe6006c4ed906d12535248d16f75a8bacb154d56841c071907c1650eeb2d21332761cd878cdcad512138a5e00263f59cf092a219c0a4a38700037614373abc49e3aa4c38633c9e113aa94a19d34df3fb9da5";
const proofPoints = Uint8Array.from(proofHex.match(/.{2}/g).map((b) => parseInt(b, 16)));

const proof = {
  root: 4023688209857926016730691838838984168964497755397275208674494663143007853450n,
  publicValue: 200000n,
  inputNullifier0: 8874489674610852055365825450502871696107617634674944839590774381311671432138n,
  inputNullifier1: 14735100347003117441335642801124275357118802347964005792522872815119077059237n,
  outputCommitment0: 17408295006874939298598769143181987675548030690756001296663597550777327872539n,
  outputCommitment1: 12013773756360371331370722014999054062474954786002594294326912317717327531506n,
};

const tx = new Transaction();

const proofArg = tx.moveCall({
  target: `${PKG}::proof::new`,
  typeArguments: [COIN_TYPE],
  arguments: [
    tx.pure.address(POOL),
    tx.pure(bcs.vector(bcs.u8()).serialize(proofPoints)),
    tx.pure(bcs.u256().serialize(proof.root)),
    tx.pure(bcs.u256().serialize(proof.publicValue)),
    tx.pure(bcs.u256().serialize(proof.inputNullifier0)),
    tx.pure(bcs.u256().serialize(proof.inputNullifier1)),
    tx.pure(bcs.u256().serialize(proof.outputCommitment0)),
    tx.pure(bcs.u256().serialize(proof.outputCommitment1)),
  ],
});

// Self-submit path: relayer = @0x0 disables the relayer gate, so the deposit
// sender (the USDsui coin owner) can submit directly. This is the unsponsored
// `transact` path — it does NOT weaken the proof/caps/VK in any way.
const SELF_SUBMIT = "0x0000000000000000000000000000000000000000000000000000000000000000";
const extArg = tx.moveCall({
  target: `${PKG}::ext_data::new`,
  arguments: [
    tx.pure(bcs.u64().serialize(200000n)), // value
    tx.pure(bcs.bool().serialize(true)), // value_sign = deposit
    tx.pure.address(SELF_SUBMIT),
    tx.pure(bcs.u64().serialize(0n)), // relayer_fee
    tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array([1, 2, 3]))),
    tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array([4, 5, 6]))),
  ],
});

// Deposit coin: split EXACTLY 200000 off the real USDsui coin (allowlisted SplitCoins glue).
// Pin the coin's on-chain ref so the PTB builds fully offline.
const usdsuiCoinRef = tx.objectRef({
  objectId: USDSUI_COIN,
  version: "697461204",
  digest: "5K2bpN9XzNtuHaWKBSdRuz4Vw5AAxzAygcAPBVUbAddD",
});
const [depositCoin] = tx.splitCoins(usdsuiCoinRef, [tx.pure.u64(200000n)]);

// Pool is a shared object (initial_shared_version 919114728), mutable.
const poolArg = tx.sharedObjectRef({
  objectId: POOL,
  initialSharedVersion: "919114728",
  mutable: true,
});

const out = tx.moveCall({
  target: `${PKG}::shielded_pool::transact`,
  typeArguments: [COIN_TYPE],
  arguments: [poolArg, depositCoin, proofArg, extArg],
});

// transact returns a Coin (zero on deposit) -> to the submitter.
tx.transferObjects([out], tx.pure.address(COIN_OWNER));

// Build the TransactionKind bytes (no gas/sender) for sui_devInspectTransactionBlock.
const kindBytes = await tx.build({ onlyTransactionKind: true });
const kindB64 = toBase64(kindBytes);

// Sender = RELAYER so on-chain ext_data::assert_relayer(sender == relayer) passes.
// devInspect does NOT enforce object ownership/signatures — it only reads state.
const body = {
  jsonrpc: "2.0",
  id: 1,
  method: "sui_devInspectTransactionBlock",
  params: [COIN_OWNER, kindB64, null, null],
};
const resp = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const j = await resp.json();
if (j.error) {
  console.log("RPC error:", JSON.stringify(j.error));
  process.exit(1);
}
const res = j.result;
console.log("DEPOSIT devInspect status:", res.effects?.status?.status);
if (res.effects?.status?.error) console.log("abort error:", res.effects.status.error);
console.log("gas used:", JSON.stringify(res.effects?.gasUsed));
const events = (res.events ?? []).map((e) => e.type.split("::").slice(-1)[0]);
console.log("events:", events.join(", ") || "(none)");

// Export the full PTB JSON for the validate-commands check.
const json = await tx.toJSON();
const fs = await import("node:fs");
fs.writeFileSync("/tmp/shield-deposit-ptb.json", json);
console.log("PTB JSON written to /tmp/shield-deposit-ptb.json");
