import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { describe, it, expect, beforeAll } from "vitest";

const PKG = "0x" + "ab".repeat(32);
const RELAYER = "0x" + "cd".repeat(32);
const POOL = "0x" + "ef".repeat(32);
const ZERO_COIN = "0x" + "12".repeat(32);

beforeAll(() => {
  process.env.SHIELD_PKG = PKG;
  process.env.SHIELD_RELAYER_ADDRESS = RELAYER;
  process.env.SHIELD_MAX_RELAYER_FEE = "1000000";
});

describe("validateTransactCommands", () => {
  it("accepts a real SDK-built withdraw PTB and rejects a duplicate ext_data::new", async () => {
    const { buildTransact } = await import("../../lib/shield/sdk/tx");
    const { validateTransactCommands } = await import("../../lib/shield/validate-commands");
    const { bcs } = await import("@mysten/sui/bcs");

    const proof = {
      proofPoints: new Uint8Array(32), root: 1n, publicValue: 2n,
      inputNullifier0: 3n, inputNullifier1: 4n,
      outputCommitment0: 5n, outputCommitment1: 6n,
    } as never;
    const ext = {
      value: 100n, valueSign: false, relayer: RELAYER, relayerFee: 0n,
      encryptedOutput0: new Uint8Array(4), encryptedOutput1: new Uint8Array(4),
    } as never;
    const exit = "0x" + "77".repeat(32);

    const tx = buildTransact({
      packageId: PKG, coinType: "0x2::sui::SUI", poolObjectId: POOL,
      poolAddress: POOL, proof, ext,
      zeroCoinSourceId: ZERO_COIN, outputRecipient: exit,
    } as never);
    const json = await tx.toJSON();

    // Baseline: the genuine SDK shape still validates.
    const ok = validateTransactCommands(json, { exitAddress: exit });
    expect(ok.relayer).toBe(RELAYER);

    // Attack: inject a SECOND ext_data::new naming relayer @0x0 with a huge fee.
    const parsed = JSON.parse(json);
    const cmds = parsed.commands;
    const extIdx = cmds.findIndex(
      (c: any) => c.MoveCall?.module === "ext_data" && c.MoveCall?.function === "new"
    );
    expect(extIdx).toBeGreaterThanOrEqual(0);
    const evil = JSON.parse(JSON.stringify(cmds[extIdx]));
    cmds.splice(extIdx + 1, 0, evil);
    const attacked = JSON.stringify(parsed);

    expect(() => validateTransactCommands(attacked, { exitAddress: exit })).toThrow(
      /exactly one ext_data::new/
    );
  });
});
