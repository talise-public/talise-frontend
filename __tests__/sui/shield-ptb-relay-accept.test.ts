/**
 * END-TO-END relay-acceptance: build the transact PTBs with the REAL SDK
 * (buildTransact) using REAL Groth16 proofs, serialize with the SAME `toJSON()`
 * that flow.ts POSTs to /api/shield/relay, then run the REAL command allowlist
 * (validateTransactCommands) — the relayer's security gate — over them. If this
 * passes, the relayer would sponsor + submit these PTBs unchanged.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildTransact, type ProofInputs, type ExtDataInput } from "@/lib/shield/sdk/tx";
import { encryptNote, encPublicKeyFromScalar } from "@/lib/shield/sdk/encrypt";
import { deriveShieldKeypairFromSeed, deriveShieldEncScalar } from "@/lib/shield/sdk/keys";
import { USDSUI_TYPE } from "@/lib/usdsui";

const PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
const POOL = "0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1";
const RELAYER = "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
const EXIT = "0x3333333333333333333333333333333333333333333333333333333333333333";
const DEPOSIT_COIN = "0x1111111111111111111111111111111111111111111111111111111111111111";
const ZERO_SRC = "0x2222222222222222222222222222222222222222222222222222222222222222";

process.env.SHIELD_PKG = PKG;
process.env.SHIELD_RELAYER_ADDRESS = RELAYER;
process.env.SHIELD_MAX_RELAYER_FEE = "1000000";

const DEPOSIT = {
  proofHex:
    "5020fd816849f98d4f4289829ccadd536a48399f09a877973a1882c6e146231c" +
    "699a2854f44d3d9d25f4b5de16bc62ff303e379f9211f9f167adad5b40dd701c" +
    "6611886acb629f5d7d8d3d73b58331d59f3f06cc02e9c34d2ffd60bdc6549b80" +
    "cb84a94a558ecd087c40810ef2b499b39b3d4b88a35774972e46406edba50f80",
  root: 0n,
  publicValue: 1000n,
  null0: 8874489674610852055365825450502871696107617634674944839590774381311671432138n,
  null1: 14735100347003117441335642801124275357118802347964005792522872815119077059237n,
  comm0: 10899760595461394734908702959981595356369358741961556886393143045034375590965n,
  comm1: 12013773756360371331370722014999054062474954786002594294326912317717327531506n,
};
const WITHDRAW = {
  proofHex:
    "9a2448e38ddc8f0b6f97aee7bf68e3aaf500df2f370d6767d2a8fc2a7f93168c" +
    "208dec5c51326279ef44457fadebcb6fb1504fe23a026c953fa5f41a5f602315" +
    "9fd81a808c22ebfbbd5ad099afba8b61fa7925f04cde5e58b37cfa0e1879bb0e" +
    "964ce254230a64cc30080da0b8c9775c3c89e9a31c3ed34f8d33e5a54cb14b30",
  root: 21299735462063983358185664815009242608878032591883643376265563669177668845388n,
  publicValue: 21888242871839275222246405745257275088548364400416034343698204186575808494617n,
  null0: 17365993652607252536207177426781989436768987297164408994060731883744541373214n,
  null1: 19675119579309133727559111446548914456322699056414605618053998085928210688930n,
  comm0: 1004813861286602095921333519409224192067649416039090645479339872202520620727n,
  comm1: 6793229471391900658229276096589399136326421784747819562673931439168574900104n,
};

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}
async function ext(valueSign: boolean, value: bigint): Promise<ExtDataInput> {
  const kp = await deriveShieldKeypairFromSeed(new Uint8Array(32).fill(7));
  const d = await deriveShieldEncScalar(kp.spendingKey);
  const pub = encPublicKeyFromScalar(d);
  const e0 = await encryptNote({ amount: value, pubkey: kp.publicKey, blinding: 777n, pool: BigInt(POOL) }, pub);
  const e1 = await encryptNote({ amount: 0n, pubkey: kp.publicKey, blinding: 666n, pool: BigInt(POOL) }, pub);
  return { value, valueSign, relayer: RELAYER, relayerFee: 0n, encryptedOutput0: e0, encryptedOutput1: e1 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validate: any;

describe("shield PTB relay acceptance (real SDK build -> real validator)", () => {
  beforeAll(async () => {
    ({ validateTransactCommands: validate } = await import("@/lib/shield/validate-commands"));
  });

  it("DEPOSIT toJSON passes the command allowlist", async () => {
    const proof: ProofInputs = {
      proofPoints: hexToBytes(DEPOSIT.proofHex),
      root: DEPOSIT.root,
      publicValue: DEPOSIT.publicValue,
      inputNullifier0: DEPOSIT.null0,
      inputNullifier1: DEPOSIT.null1,
      outputCommitment0: DEPOSIT.comm0,
      outputCommitment1: DEPOSIT.comm1,
    };
    const tx = buildTransact({
      packageId: PKG, coinType: USDSUI_TYPE, poolObjectId: POOL, poolAddress: POOL,
      proof, ext: await ext(true, 1000n), depositCoinId: DEPOSIT_COIN, outputRecipient: RELAYER,
    });
    const json = await tx.toJSON();
    const res = validate(json, { exitAddress: null });
    // eslint-disable-next-line no-console
    console.log("DEPOSIT validator OK:", JSON.stringify(res, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    expect(res.relayer?.toLowerCase()).toContain("37949e572bbc9cd57b7817cf3d309c0fa1b5361e");
  });

  it("WITHDRAW toJSON passes the command allowlist (exit-pinned)", async () => {
    const proof: ProofInputs = {
      proofPoints: hexToBytes(WITHDRAW.proofHex),
      root: WITHDRAW.root,
      publicValue: WITHDRAW.publicValue,
      inputNullifier0: WITHDRAW.null0,
      inputNullifier1: WITHDRAW.null1,
      outputCommitment0: WITHDRAW.comm0,
      outputCommitment1: WITHDRAW.comm1,
    };
    const tx = buildTransact({
      packageId: PKG, coinType: USDSUI_TYPE, poolObjectId: POOL, poolAddress: POOL,
      proof, ext: await ext(false, 1000n), zeroCoinSourceId: ZERO_SRC, outputRecipient: EXIT,
    });
    const json = await tx.toJSON();
    const res = validate(json, { exitAddress: EXIT });
    // eslint-disable-next-line no-console
    console.log("WITHDRAW validator OK:", JSON.stringify(res, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    expect(res.relayer?.toLowerCase()).toContain("37949e572bbc9cd57b7817cf3d309c0fa1b5361e");
  });
});
