// Simulate the shielded WITHDRAW transact PTB on mainnet via devInspect, AND
// validate it through the FIXED validate-commands.ts relay control.
// Uses a REAL Groth16 proof (prove_withdraw_mainnet) bound to the mainnet pool,
// targeting the POST-DEPOSIT root (the root the tree holds after the deposit leg).
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { toBase64 } from "@mysten/sui/utils";

const RPC = "https://fullnode.mainnet.sui.io:443";
const PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
const POOL = "0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1";
const COIN_TYPE = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const RELAYER = "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
const EXIT = "0x39d4ded1f081c828662dcbf4a43c9183c9e10510112e269d961cf89c90b1ae7b"; // screened withdraw recipient
const USDSUI_COIN = "0x8a1c28a71ddfb123581eef0325c42212f3ce4161a4fc06b1702914c777ad4b27";

// ---- REAL mainnet withdraw proof (post-deposit root, public_value = r - 200000) ----
const proofHex =
  "98fef8f8b49e362a503adffde28478ed95934417caf2500bf21f7aa664b5ae8536d492e9b0b0cb1e4e8e489b99401b00ae4f076f988f311ea53789f77503ac0f25a6e4af6d9c3bb4a93366b7376569f23f8ead26e8da2d725bc29e5eeebbc3928940010aecbba631af0d4d30cfb2eec187f9a1771f6fe98e40a15940f011d705";
const proofPoints = Uint8Array.from(proofHex.match(/.{2}/g).map((b) => parseInt(b, 16)));

const proof = {
  root: 7943929642939265571698669120752355917770345621870864687289709808502377622408n,
  publicValue: 21888242871839275222246405745257275088548364400416034343698204186575808295617n,
  inputNullifier0: 19760002051741290239159706962632335563595838592381788937987853198416413259529n,
  inputNullifier1: 19675119579309133727559111446548914456322699056414605618053998085928210688930n,
  outputCommitment0: 1004813861286602095921333519409224192067649416039090645479339872202520620727n,
  outputCommitment1: 6793229471391900658229276096589399136326421784747819562673931439168574900104n,
};

// relayerAddr: the ExtData.relayer. For the on-chain crypto SIM we use @0x0
// (self-submit, no relayer gate) so the coin owner can sign — this exercises the
// identical Groth16/nullifier/conservation path. For the validate-commands RELAY
// check we rebuild with the REAL relayer (that control pins relayer == ours).
function buildWithdrawTx(relayerAddr) {
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

  // ExtData: withdraw 200000, value_sign=false, relayer = OUR relayer, fee 0.
  const extArg = tx.moveCall({
    target: `${PKG}::ext_data::new`,
    arguments: [
      tx.pure(bcs.u64().serialize(200000n)), // value (magnitude withdrawn)
      tx.pure(bcs.bool().serialize(false)), // value_sign = withdraw
      tx.pure.address(relayerAddr),
      tx.pure(bcs.u64().serialize(0n)), // relayer_fee
      tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array([1, 2, 3]))),
      tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array([4, 5, 6]))),
    ],
  });

  // Withdraw leg: deposit coin must be a ZERO coin. Split [0] off a relayer coin
  // via the allowlisted SplitCoins glue (here the real USDsui coin, split 0 keeps it whole).
  const usdsuiCoinRef = tx.objectRef({
    objectId: USDSUI_COIN,
    version: "697461204",
    digest: "5K2bpN9XzNtuHaWKBSdRuz4Vw5AAxzAygcAPBVUbAddD",
  });
  const [zeroCoin] = tx.splitCoins(usdsuiCoinRef, [tx.pure.u64(0n)]);

  const poolArg = tx.sharedObjectRef({
    objectId: POOL,
    initialSharedVersion: "919114728",
    mutable: true,
  });

  const out = tx.moveCall({
    target: `${PKG}::shielded_pool::transact`,
    typeArguments: [COIN_TYPE],
    arguments: [poolArg, zeroCoin, proofArg, extArg],
  });

  // Withdraw return coin (the unshielded 200000) -> screened exit address.
  tx.transferObjects([out], tx.pure.address(EXIT));
  return tx;
}

// ── 1. SIM: self-submit (relayer=@0x0), sender = coin owner so the zero-coin
//        split reservation is valid. Exercises the identical on-chain crypto path.
const SELF = "0x0000000000000000000000000000000000000000000000000000000000000000";
const simTx = buildWithdrawTx(SELF);
const kindBytes = await simTx.build({ onlyTransactionKind: true });
const resp = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sui_devInspectTransactionBlock",
    params: [EXIT, toBase64(kindBytes), null, null], // EXIT (0x39d4) owns the coin
  }),
});
const j = await resp.json();
if (j.error) {
  console.log("RPC error:", JSON.stringify(j.error));
} else {
  const res = j.result;
  console.log("WITHDRAW devInspect status:", res.effects?.status?.status);
  if (res.effects?.status?.error) console.log("abort error:", res.effects.status.error);
  const events = (res.events ?? []).map((e) => e.type.split("::").slice(-1)[0]);
  console.log("events:", events.join(", ") || "(none)");
}

// ── 2. Export the REAL-relayer PTB for the validate-commands relay-control check.
const relayTx = buildWithdrawTx(RELAYER);
const json = await relayTx.toJSON();
const fs = await import("node:fs");
fs.writeFileSync("/tmp/shield-withdraw-ptb.json", json);
console.log("REAL-relayer PTB JSON written to /tmp/shield-withdraw-ptb.json");
