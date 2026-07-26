import "server-only";

/**
 * THE relayer security control (ported from Vortex's command-allowlist).
 *
 * The relayer signs as gas owner (via Onara) and sets itself as `sender` on
 * a user-supplied PTB. That is a blank cheque UNLESS the PTB shape is pinned
 * exactly. An unconstrained relayer is a drain hole: a malicious `txBytes`
 * could call ANY Move function with the relayer as sender. So before we ever
 * hand the bytes to Onara we parse the serialized PTB and assert it matches -
 * to the command, the shielded `transact` / `transact_with_account` shape:
 *
 *   • EXACTLY ONE `MoveCall`, and it targets
 *     `${SHIELD_PKG}::shielded_pool::transact[_with_account]`
 *     with the package id pinned via `normalizeSuiAddress` (no other package,
 *     no other module, no other function).
 *   • Only the allowed preceding constructor / coin-glue commands
 *     (SplitCoins, MergeCoins, MakeMoveVec), everything else (TransferObjects,
 *     Publish, Upgrade, Intents, a second MoveCall, …) is rejected.
 *   • `ExtData.relayer == OUR relayer address` and `ExtData.relayer_fee <= MAX`.
 *     The proof + ext_data are constructed client-side; without this check a
 *     user could name a different relayer (griefing) or set an enormous fee
 *     that the on-chain `transact` would happily pay OUT of the pool to the
 *     attacker.
 *
 * NOTE on `proof::new` / `ext_data::new`: in the live PTB these are Move
 * constructor calls. But each is a MoveCall, and the on-chain `transact`
 * takes `Proof` + `ExtData` BY VALUE, so a real relayed PTB would contain
 * MULTIPLE MoveCalls (proof::new, ext_data::new, shielded_pool::transact).
 * To keep this control airtight we DO allow `proof::new` and `ext_data::new`
 * MoveCalls, but ONLY against the SAME pinned package, and we still require
 * EXACTLY ONE call to `shielded_pool::transact[_with_account]`. Any MoveCall
 * to a different package/module/function is rejected. This is the seam where
 * the ExtData arguments are read (see `extractExtData`).
 *
 * NOTE on `TransferObjects`: the on-chain `transact` RETURNS a `Coin<CoinType>`
 * by value that MUST be consumed in the same PTB. There is no Move call on the
 * allowlist that consumes it, so the PTB delivers it with exactly ONE trailing
 * `TransferObjects`. We allow that single command under a tight constraint:
 *   • its sole object operand is the `transact` Result (NestedResult/Result of
 *     the one transact MoveCall), never a free input/object, so it can only
 *     route the proof-bound, ≤$10-capped return coin (NOT the deposit coin);
 *   • its recipient resolves to the relay route's already-screened
 *     `exitAddress` (threaded in by the caller). If no exit was screened
 *     (deposit / internal-transfer legs, whose return coin is a zero coin),
 *     the recipient MUST be our own relayer address.
 * This is additive: it loosens nothing about the proof, caps, or the pinned
 * transact shape, it only lets the mandatory return-coin delivery through.
 */

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import {
  shieldPackageId,
  shieldRelayerAddress,
  shieldMaxRelayerFee,
  SHIELD_MODULE,
} from "./relayer-config";

// ── Allowlists ───────────────────────────────────────────────────────────

/** The single terminal MoveCall function names allowed on the pinned module. */
const TRANSACT_FNS = new Set(["transact", "transact_with_account"]);

/** Constructor MoveCalls allowed against the pinned package (assemble Proof/ExtData). */
const CONSTRUCTOR_TARGETS = new Set([
  "proof::new",
  "ext_data::new",
]);

/**
 * Non-MoveCall command kinds permitted to PRECEDE the transact call. These are
 * pure coin/vector glue with no ability to move value to an arbitrary address.
 * Notably ABSENT: TransferObjects (could send the deposit coin anywhere),
 * Publish, Upgrade, MakeMoveVec is allowed (used to build the Receiving vector
 * for the with-account path), $Intent (opaque, reject).
 */
const ALLOWED_NON_MOVECALL_KINDS = new Set([
  "SplitCoins",
  "MergeCoins",
  "MakeMoveVec",
]);

export class ShieldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShieldValidationError";
  }
}

export type ValidatedTransact = {
  /** "transact" | "transact_with_account" */
  fn: string;
  /** The relayer-fee read out of the ExtData pure arg, when statically known. */
  relayerFee: bigint | null;
  /** The relayer address read out of the ExtData pure arg, when statically known. */
  relayer: string | null;
};

/**
 * Options for {@link validateTransactCommands}.
 *
 * `exitAddress` is the already-screened withdraw destination from the relay
 * route. When present, the single allowed `TransferObjects` MUST send the
 * transact return coin there. When absent (deposit / internal-transfer legs),
 * the return coin is a zero coin and MUST go to our own relayer address.
 */
export type ValidateOptions = {
  exitAddress?: string | null;
};

type TxData = ReturnType<Transaction["getData"]>;
type Command = TxData["commands"][number];
type Input = TxData["inputs"][number];

/**
 * Parse the serialized PTB, assert it is EXACTLY a shielded `transact` shape,
 * and assert the ExtData relayer + fee. Throws `ShieldValidationError` on ANY
 * deviation, the relay route maps that to a 400 and NEVER forwards the bytes.
 *
 * `txBytes` is the base64 BCS-serialized TransactionKind/Transaction the client
 * built (same `toBase64(tx.build(...))` shape the send routes produce).
 */
export function validateTransactCommands(
  txBytesB64: string,
  opts: ValidateOptions = {}
): ValidatedTransact {
  const pkg = shieldPackageId();
  const relayer = shieldRelayerAddress();
  if (!pkg || !relayer) {
    // Fail-closed: with no pinned package / relayer we cannot enforce anything.
    throw new ShieldValidationError("shield relayer not configured");
  }
  // The screened exit address (if any) the return coin is allowed to go to.
  // Normalized for an exact, case-insensitive compare against the PTB recipient.
  const allowedExit = opts.exitAddress
    ? (() => {
        try {
          return normalizeSuiAddress(opts.exitAddress!.trim());
        } catch {
          return null;
        }
      })()
    : null;

  let data: TxData;
  try {
    // `Transaction.from` auto-detects the serialized form. The SDK sends the
    // full serialized transaction as a JSON string (`await tx.toJSON()`, see
    // flow.ts), which is exactly what the relay route's executor also feeds to
    // `Transaction.from(txBytes)`. Parse the SAME input here, do NOT base64-
    // decode first (that corrupts a JSON string → "Invalid character" and would
    // reject every real PTB). A base64 BCS string is still accepted by
    // `Transaction.from` directly, so this is strictly more compatible.
    data = Transaction.from(txBytesB64).getData();
  } catch (e) {
    throw new ShieldValidationError(
      `unparseable transaction bytes: ${(e as Error).message}`
    );
  }

  const commands = data.commands ?? [];
  if (commands.length === 0) {
    throw new ShieldValidationError("empty PTB");
  }
  // Hard ceiling: a legit shielded tx is proof::new + ext_data::new +
  // (optional split/merge/makevec glue) + one transact. A handful of commands.
  if (commands.length > 12) {
    throw new ShieldValidationError(
      `too many commands (${commands.length}); shielded transact is a small fixed PTB`
    );
  }

  let transactCount = 0;
  let transactCmd: Command | null = null;
  /** Command index of the one transact MoveCall (for the TransferObjects bind). */
  let transactIdx = -1;
  let transferCount = 0;
  let transferCmd: Command | null = null;
  /**
   * Per-constructor counts. `extractExtData` resolves the ExtData by taking the
   * FIRST `ext_data::new` in the PTB, but nothing forced `transact` to consume
   * THAT one. A PTB carrying TWO `ext_data::new` calls (a compliant decoy first,
   * the real one second) would be validated against the decoy while `transact`
   * consumed the attacker's, defeating the relayer + fee assertions entirely.
   *
   * Pinning each constructor to EXACTLY ONE occurrence closes the substitution:
   * `Proof` / `ExtData` are non-`key` structs, so they cannot be supplied as a
   * Pure or object input, they can ONLY reach `transact` as the Result of an
   * in-PTB constructor. With exactly one of each in the PTB, the value we
   * validate is necessarily the value `transact` consumes.
   *
   * The SDK's `buildTransact` (lib/shield/sdk/tx.ts) emits exactly one
   * `proof::new` and one `ext_data::new`, so this rejects nothing legitimate.
   */
  let extDataNewCount = 0;
  let proofNewCount = 0;

  commands.forEach((cmd, idx) => {
    const kind = cmd.$kind;

    if (kind === "MoveCall") {
      const mc = cmd.MoveCall;
      const cmdPkg = normalizePkg(mc.package);
      // Every MoveCall MUST be against OUR pinned package, no exceptions.
      if (cmdPkg !== pkg) {
        throw new ShieldValidationError(
          `MoveCall to foreign package ${cmdPkg} (only ${pkg} allowed)`
        );
      }
      const modFn = `${mc.module}::${mc.function}`;

      if (mc.module === SHIELD_MODULE && TRANSACT_FNS.has(mc.function)) {
        transactCount += 1;
        transactCmd = cmd;
        transactIdx = idx;
        return;
      }
      if (CONSTRUCTOR_TARGETS.has(modFn)) {
        // proof::new / ext_data::new, allowed assembly calls. Counted so the
        // duplicate-constructor substitution attack is rejected below.
        if (modFn === "ext_data::new") extDataNewCount += 1;
        else proofNewCount += 1;
        return;
      }
      throw new ShieldValidationError(
        `disallowed MoveCall ${cmdPkg}::${modFn}`
      );
    }

    // EXACTLY ONE TransferObjects is allowed (delivers the transact return
    // coin). Capture it here; bind its operand + recipient after the loop, once
    // the transact result index is known.
    if (kind === "TransferObjects") {
      transferCount += 1;
      transferCmd = cmd;
      return;
    }

    // Non-MoveCall command, must be on the coin/vector-glue allowlist.
    if (!ALLOWED_NON_MOVECALL_KINDS.has(kind)) {
      throw new ShieldValidationError(`disallowed command kind ${kind}`);
    }
  });

  // `transactCmd` / `transferCmd` are assigned inside the forEach closure, so TS
  // does not flow-narrow them here, read through explicitly-typed locals.
  const finalTransact = transactCmd as Command | null;
  if (transactCount !== 1 || !finalTransact || finalTransact.$kind !== "MoveCall") {
    throw new ShieldValidationError(
      `expected exactly one shielded_pool::transact[_with_account], found ${transactCount}`
    );
  }

  // ── Constructor uniqueness (anti-substitution) ────────────────────────────
  // See the note on `extDataNewCount` above: more than one constructor call
  // would let the PTB validate against a decoy while `transact` consumes a
  // different Proof / ExtData.
  if (extDataNewCount !== 1) {
    throw new ShieldValidationError(
      `expected exactly one ext_data::new, found ${extDataNewCount}`
    );
  }
  if (proofNewCount !== 1) {
    throw new ShieldValidationError(
      `expected exactly one proof::new, found ${proofNewCount}`
    );
  }

  // ── The single TransferObjects that delivers the transact return coin ──────
  const finalTransfer = transferCmd as Command | null;
  if (transferCount > 1) {
    throw new ShieldValidationError(
      `at most one TransferObjects allowed, found ${transferCount}`
    );
  }
  if (transferCount === 1 && finalTransfer) {
    assertReturnCoinTransfer(finalTransfer, transactIdx, data.inputs, {
      relayer,
      allowedExit,
    });
  }

  const mc = finalTransact.MoveCall;

  // ── ExtData relayer + fee assertions ────────────────────────────────────
  // The `transact` signature is:
  //   transact(self, registry, deposit: Coin, proof: Proof, ext_data: ExtData, ctx)
  // ExtData is assembled by an `ext_data::new(value, value_sign, relayer,
  // relayer_fee, enc0, enc1)` MoveCall. We locate that call and read its
  // `relayer` + `relayer_fee` pure inputs. If the ExtData was instead passed as
  // an opaque pre-serialized arg we cannot statically verify it → reject,
  // because skipping the check would defeat the whole control.
  const ext = extractExtData(commands, data.inputs, pkg);

  if (ext.relayer === null || ext.relayerFee === null) {
    throw new ShieldValidationError(
      "could not statically resolve ExtData.relayer / relayer_fee from the PTB"
    );
  }
  if (ext.relayer !== relayer) {
    throw new ShieldValidationError(
      `ExtData.relayer ${ext.relayer} != our relayer ${relayer}`
    );
  }
  const maxFee = shieldMaxRelayerFee();
  if (ext.relayerFee > maxFee) {
    throw new ShieldValidationError(
      `ExtData.relayer_fee ${ext.relayerFee} exceeds max ${maxFee}`
    );
  }

  return { fn: mc.function, relayer: ext.relayer, relayerFee: ext.relayerFee };
}

// ── Return-coin TransferObjects binding ─────────────────────────────────────

/**
 * Assert the single `TransferObjects` command does nothing but route the
 * `transact` RETURN coin to an approved recipient:
 *   • its sole `objects` operand is the Result of the one transact MoveCall
 *     (command index {@link transactIdx}), NOT a free input/object, so it
 *     cannot exfiltrate the deposit coin or any other object;
 *   • its recipient resolves to a Pure address that equals either the screened
 *     `exitAddress` (withdraw) or our own relayer address (deposit / internal
 *     transfer, where the return coin is a zero coin).
 *
 * Any deviation throws `ShieldValidationError`. This keeps the relayer from
 * being used to move arbitrary objects while still allowing the mandatory
 * return-coin delivery.
 */
function assertReturnCoinTransfer(
  cmd: Command,
  transactIdx: number,
  inputs: Input[],
  approved: { relayer: string; allowedExit: string | null }
): void {
  if (cmd.$kind !== "TransferObjects") {
    throw new ShieldValidationError("expected TransferObjects command");
  }
  const t = cmd.TransferObjects;

  // 1. Exactly ONE object operand, and it is the transact Result.
  const objs = t.objects ?? [];
  if (objs.length !== 1) {
    throw new ShieldValidationError(
      `TransferObjects must move exactly one object (the transact return coin), found ${objs.length}`
    );
  }
  const obj = objs[0];
  const isTransactResult =
    (obj.$kind === "Result" && obj.Result === transactIdx) ||
    (obj.$kind === "NestedResult" && obj.NestedResult[0] === transactIdx);
  if (!isTransactResult) {
    throw new ShieldValidationError(
      "TransferObjects operand is not the transact return coin"
    );
  }

  // 2. Recipient is a Pure address that matches an approved destination.
  if (t.address.$kind !== "Input") {
    throw new ShieldValidationError(
      "TransferObjects recipient must be a pure address input"
    );
  }
  const recipient = decodeAddressInput(t.address, inputs);
  if (!recipient) {
    throw new ShieldValidationError(
      "could not statically resolve TransferObjects recipient"
    );
  }
  const recipientNorm = (() => {
    try {
      return normalizeSuiAddress(recipient);
    } catch {
      return recipient;
    }
  })();

  // Withdraw: must equal the screened exit. Deposit / internal transfer (no
  // screened exit): the return coin is a zero coin and must go to the relayer.
  const target = approved.allowedExit ?? approved.relayer;
  if (recipientNorm !== target) {
    throw new ShieldValidationError(
      approved.allowedExit
        ? `TransferObjects recipient ${recipientNorm} != screened exit ${target}`
        : `TransferObjects recipient ${recipientNorm} != relayer ${target} (no screened exit for this leg)`
    );
  }
}

// ── ExtData extraction ─────────────────────────────────────────────────────

type ExtDataRead = { relayer: string | null; relayerFee: bigint | null };

/**
 * Find the `ext_data::new(...)` MoveCall and decode its `relayer` (arg index 2)
 * + `relayer_fee` (arg index 3) pure inputs. Argument order matches
 * `ext_data::new(value, value_sign, relayer, relayer_fee, enc0, enc1)`.
 *
 * Returns nulls if the ExtData isn't assembled by an in-PTB `ext_data::new`
 * call (the caller treats nulls as a hard reject).
 */
function extractExtData(
  commands: Command[],
  inputs: Input[],
  pkg: string
): ExtDataRead {
  const newCall = commands.find(
    (c) =>
      c.$kind === "MoveCall" &&
      normalizePkg(c.MoveCall.package) === pkg &&
      c.MoveCall.module === "ext_data" &&
      c.MoveCall.function === "new"
  );
  if (!newCall || newCall.$kind !== "MoveCall") {
    return { relayer: null, relayerFee: null };
  }

  const args = newCall.MoveCall.arguments;
  // ext_data::new(value, value_sign, relayer, relayer_fee, enc0, enc1)
  const relayerArg = args[2];
  const feeArg = args[3];

  const relayer = decodeAddressInput(relayerArg, inputs);
  const relayerFee = decodeU64Input(feeArg, inputs);
  return { relayer, relayerFee };
}

type MoveCallCommand = Extract<Command, { $kind: "MoveCall" }>;
type Arg = MoveCallCommand["MoveCall"]["arguments"][number];
/**
 * The minimal structural shape we read off an argument / recipient ref: both a
 * MoveCall {@link Arg} and a `TransferObjects.address` are an `{ $kind, Input }`
 * union at runtime, so we widen to this for the shared pure-bytes decoder.
 */
type InputRefLike = { $kind: string; Input?: number };

/** Resolve a MoveCall argument back to its Pure input bytes, if it is one. */
function pureBytes(
  arg: Arg | InputRefLike | undefined,
  inputs: Input[]
): Uint8Array | null {
  if (!arg || arg.$kind !== "Input" || typeof arg.Input !== "number") return null;
  const input = inputs[arg.Input];
  if (!input) return null;
  if (input.$kind === "Pure") {
    try {
      return fromBase64(input.Pure.bytes);
    } catch {
      return null;
    }
  }
  // UnresolvedPure values can't be byte-decoded reliably here; reject upstream.
  return null;
}

function decodeAddressInput(
  arg: Arg | InputRefLike | undefined,
  inputs: Input[]
): string | null {
  const b = pureBytes(arg, inputs);
  if (!b) return null;
  try {
    return bcs.Address.parse(b);
  } catch {
    return null;
  }
}

function decodeU64Input(arg: Arg | undefined, inputs: Input[]): bigint | null {
  const b = pureBytes(arg, inputs);
  if (!b) return null;
  try {
    return BigInt(bcs.u64().parse(b));
  } catch {
    return null;
  }
}

/** Normalize a command's package id to the same 0x-prefixed 64-hex form. */
function normalizePkg(pkg: string): string {
  // `getData()` already returns normalized 0x… addresses, but normalize again
  // defensively so the equality check against `shieldPackageId()` is exact.
  try {
    return normalizeSuiAddress(pkg);
  } catch {
    return pkg;
  }
}
