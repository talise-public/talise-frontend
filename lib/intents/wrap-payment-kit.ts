import "server-only";

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { globalRegistryId } from "@/lib/payment-kit";
import { USDSUI_TYPE } from "@/lib/usdsui";

/**
 * Mainnet Payment Kit package address. Pulled from
 * `@mysten/payment-kit/dist/constants.mjs::MAINNET_PAYMENT_KIT_PACKAGE_CONFIG`.
 *
 * Why we hard-code this here instead of relying on
 * `client.calls.processRegistryPayment(...)`:
 *
 * The SDK's contract binding accepts `options.package` and defaults to the
 * unresolved MVR name `"@mysten/payment-kit"`. The SDK's higher-level
 * `PaymentKitCalls.processRegistryPayment` does NOT forward
 * `packageConfig.packageId` into that `options.package` field, so the
 * underlying `tx.moveCall` ends up with `package: "@mysten/payment-kit"`.
 * The `@mysten/sui` build path then needs an MVR resolver to translate
 * the literal into the real address; ours doesn't have one wired, so the
 * call serializes as a zero-padded garbage address and the validator
 * silently drops it (the rest of the PTB still executes, that's why
 * the user's send appeared to succeed but the chain has no
 * PaymentRecord). Build the MoveCall directly with the real package
 * address and we get a tx that actually emits the receipt.
 */
const PAYMENT_KIT_PACKAGE_MAINNET =
  "0xbc126f1535fba7d641cb9150ad9eae93b104972586ba20f3c60bfe0e53b69bc6";

/**
 * Universal Payment Kit receipt wrapper, Plan B item 1.
 *
 * Every Talise-originated tx (send, invest, withdraw, swap, recurring,
 * split, agent-pay) ends with a `processRegistryPayment` MoveCall whose
 * `nonce` carries a structured Talise memo. Downstream, `lib/activity.ts`
 * (and any third-party indexer) can recover the kind + refs of a tx by
 * reading the PaymentRecord under the `talise` registry instead of
 * sniffing MoveCall packages heuristically.
 *
 * Why a single primitive across all kinds:
 *
 *   1. TRANSFER kinds (send / split / recur / agent_pay), the PK call
 *      IS the transfer (PK pulls a USDsui coin from sender via
 *      `coinWithBalance` and transfers to receiver). We replace the
 *      previous `coinWithBalance + transferObjects` + clock-shim combo
 *      with one PK call. Cleaner PTB, real on-chain receipt, and the
 *      PK MoveCall satisfies Onara's "≥1 MoveCall" policy so we can
 *      drop the `0x2::clock::timestamp_ms` no-op shim entirely.
 *
 *   2. NON-TRANSFER kinds (invest / withdraw / swap), the venue's
 *      own MoveCalls (NAVI `incentive_v3::entry_deposit`, DeepBook
 *      `margin_pool::supply`, Cetus swap, etc.) do the real money
 *      movement. We append a PK self-payment (sender == receiver,
 *      amount = 1 micro-USDsui) AFTER those, carrying the typed memo.
 *      Cost: 1 micro-USDsui (~$0.000001) round-trips inside the user's
 *      wallet, plus the marginal gas to mint a PaymentRecord, which
 *      Onara sponsors. Net cost to the user: nothing.
 *
 * NONCE FORMAT, hard 36-char cap (Payment Kit's `validate_nonce`
 * aborts with `EInvalidNonce` (code 8) if the byte length is 0 or
 * > 36). The earlier human-readable `talise/v1|<kind>|...` form
 * blew this budget, minimum 45 chars before any refs tags. The
 * current schema below squeezes the same info into 27-28 chars
 * (well under the cap, with room for one ref char):
 *
 *   t1<kind1><ts8><rand4><sender6><receiver6>[<refs1>]
 *
 *   t1         (2 ASCII bytes), schema marker, v1
 *   kind1      (1)           , see KIND_CODE below
 *   ts8        (8 base36)    , Date.now(). 36^8 ≈ 2.8e12 ms, so
 *                                this fits through year ~2059 in
 *                                fixed-width 8 chars
 *   rand4      (4 base36)    , collision guard within the same ms
 *                                (16M values is plenty)
 *   sender6    (6 hex)       , first 6 hex chars of sender, debug
 *                                aid only, collisions across users
 *                                are still impossible because PK
 *                                hashes the full key
 *   receiver6  (6 hex)       , real recipient (transfer kinds) or
 *                                same as sender6 (non-transfer)
 *   refs1      (0-9 chars)   , optional single-char tags, see
 *                                REF_CODE; e.g. "n" = venue:navi,
 *                                "d" = venue:deepbook
 *
 * Total: 2+1+8+4+6+6 = 27 base + up to 9 refs = 36 char ceiling
 * with margin. Pure ASCII so byte-length == char-length.
 *
 * Parsing back to a structured shape via `parsePaymentKitNonce`.
 * Bump the `"t1"` prefix to `"t2"` if/when the wire format changes
 *, the parser checks it explicitly and returns null otherwise so
 * stale clients can't misinterpret a v2 nonce as v1.
 */

export type TaliseTxKind =
  | "send"
  | "invest"
  | "withdraw"
  | "swap"
  | "recur"
  | "split"
  | "agent_pay";

/** Kinds where the PK call actually moves the user's USDsui. */
const TRANSFER_KINDS = new Set<TaliseTxKind>([
  "send",
  "split",
  "recur",
  "agent_pay",
]);

export interface PaymentKitWrapOptions {
  kind: TaliseTxKind;
  sender: string;
  /**
   * Transfer kinds: the real recipient.
   * Non-transfer kinds: defaulted to sender (caller can pass it
   * explicitly if they want, never affects funds).
   */
  receiver?: string;
  /**
   * USDsui human units. Required for transfer kinds; ignored for
   * non-transfer kinds (replaced with the 1-micro marker amount).
   */
  amountUsdsui?: number;
  /** Optional structured refs, encoded as k=v pairs in the nonce. */
  refs?: {
    venue?: string;
    invoiceId?: string;
    recurId?: string;
    escrowId?: string;
    splitId?: string;
    memo?: string;
  };
}

const SCHEMA_PREFIX = "t1";
/** Max bytes the chain allows, `EInvalidNonce` (code 8) above this. */
const NONCE_MAX_LEN = 36;
/** 1 micro-USDsui = 10^-6 USDsui = $0.000001, the non-transfer marker. */
const MARKER_AMOUNT: bigint = 1n;

/** Single-char tx kind codes, packed into a 36-byte nonce budget. */
const KIND_CODE: Record<TaliseTxKind, string> = {
  send: "s",
  invest: "i",
  withdraw: "w",
  swap: "p", // "p" for "swap", "s" is taken by send
  recur: "r",
  split: "x",
  agent_pay: "a",
};
const KIND_FROM_CODE: Record<string, TaliseTxKind> = Object.fromEntries(
  Object.entries(KIND_CODE).map(([k, v]) => [v, k as TaliseTxKind])
);

/** Single-char venue codes, for the optional ref slot. */
const VENUE_CODE: Record<string, string> = {
  navi: "n",
  deepbook: "d",
  // Bridge.xyz off-ramp (USDC-on-Sui → bank wire). The cash-out PTB
  // (/api/offramp/bridge/send-usdc-prepare) tags its `withdraw` receipt
  // with venue:bridge so the on-chain memo distinguishes a bank cash-out
  // from a NAVI/earn withdraw. Without this code the venue ref was
  // silently dropped (buildPaymentKitNonce skips unknown venues), leaving
  // the cash-out indistinguishable on chain. Adds 1 char to a ~27-char
  // nonce, well under Payment Kit's 36-byte cap.
  bridge: "b",
};
const VENUE_FROM_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(VENUE_CODE).map(([k, v]) => [v, k])
);

/**
 * Build the encoded nonce string. Exported so the iOS app + indexers
 * can construct & match deterministic nonces if they ever need to
 * (e.g. building the same memo client-side for offline preview).
 *
 * Always returns a string ≤ 36 bytes (Payment Kit's hard limit).
 */
export function buildPaymentKitNonce(opts: PaymentKitWrapOptions): string {
  const sender = opts.sender;
  const receiver = opts.receiver ?? opts.sender;
  const kindCh = KIND_CODE[opts.kind];
  if (!kindCh) {
    throw new Error(`buildPaymentKitNonce: unknown kind "${opts.kind}"`);
  }
  // Fixed-width 8-char base36 timestamp. Date.now() fits in 8 chars
  // of base36 through year ~2059, we leftPad to the full width so
  // the parser can slice by offset.
  const ts = Date.now().toString(36).padStart(8, "0").slice(-8);
  // 4-char base36 random (16M values). Plenty to dedup within the
  // same ms when a user fires multiple identical-amount txs.
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  const s = sender.replace(/^0x/, "").slice(0, 6);
  const r = receiver.replace(/^0x/, "").slice(0, 6);

  // Optional ref slot. Today we only encode venue (1 char). Invoice /
  // recur / escrow / split / memo refs would need separate handling
  // because the deterministic 36-char ceiling is too tight for free
  // text, we'd encode them via a parallel side-table keyed on digest.
  const refs = opts.refs ?? {};
  let refSlot = "";
  if (refs.venue && VENUE_CODE[refs.venue]) {
    refSlot += VENUE_CODE[refs.venue];
  }

  const nonce = `${SCHEMA_PREFIX}${kindCh}${ts}${rand}${s}${r}${refSlot}`;

  // Defensive, if a future ref slot pushes us over the cap, fail
  // loud here instead of getting a confusing on-chain abort.
  if (nonce.length > NONCE_MAX_LEN) {
    throw new Error(
      `buildPaymentKitNonce: produced ${nonce.length}-char nonce, ` +
        `exceeds Payment Kit's ${NONCE_MAX_LEN}-byte cap`
    );
  }
  return nonce;
}

/**
 * Parse a nonce back into its structured fields. Returns null if the
 * nonce isn't a Talise memo (e.g. a third-party PK invoice or a
 * pre-v1 send that didn't go through this wrapper).
 *
 * Used by `lib/activity.ts` to recover authoritative kind/refs from
 * the on-chain PaymentRecord.
 */
export interface ParsedTaliseMemo {
  schema: string;
  kind: TaliseTxKind;
  sender6: string;
  receiver6: string;
  timestampMs: number;
  refs: Record<string, string>;
}

export function parsePaymentKitNonce(nonce: string): ParsedTaliseMemo | null {
  // Fixed-width parse, slice by known offsets. Any nonce that
  // doesn't start with "t1" or is shorter than the base 27 chars is
  // not one of ours (could be a third-party PK invoice, or a v2+
  // Talise memo from a newer client).
  if (!nonce.startsWith(SCHEMA_PREFIX) || nonce.length < 27) return null;
  const kindCh = nonce[2];
  const kind = KIND_FROM_CODE[kindCh];
  if (!kind) return null;
  const ts36 = nonce.slice(3, 11);
  const timestampMs = parseInt(ts36, 36);
  if (!Number.isFinite(timestampMs)) return null;
  // rand4 at [11..15), we don't surface it, it's just a collision
  // guard inside the same millisecond.
  const sender6 = nonce.slice(15, 21);
  const receiver6 = nonce.slice(21, 27);
  const refSlot = nonce.slice(27);

  const refs: Record<string, string> = {};
  if (refSlot.length > 0) {
    // Today: single-char venue code. Any future ref chars get
    // appended after; parser ignores unknown chars rather than
    // failing the whole memo, forward-compat for v1.x additions.
    const venueCh = refSlot[0];
    const venue = VENUE_FROM_CODE[venueCh];
    if (venue) refs.venue = venue;
  }

  return {
    schema: SCHEMA_PREFIX,
    kind,
    sender6,
    receiver6,
    timestampMs,
    refs,
  };
}

/**
 * Append a Payment Kit `processRegistryPayment` call to the given PTB.
 *
 * For TRANSFER kinds (send / split / recur / agent_pay) this REPLACES
 * the caller's manual transfer, don't also call `transferObjects`
 * for the same amount, you'd be paying twice. Caller is responsible
 * for using a transfer kind only when the PK call IS the intended
 * money movement.
 *
 * For NON-TRANSFER kinds the venue's own MoveCalls in the same PTB
 * do the work; this wrapper just adds the typed marker.
 *
 * Returns the nonce string so the API route can hand it back to iOS
 * in the response, handy for the receipt screen / debug log.
 */
export function appendPaymentKitReceipt(
  tx: Transaction,
  opts: PaymentKitWrapOptions
): { nonce: string } {
  const sender = opts.sender;
  const receiver = opts.receiver ?? sender;
  const isTransfer = TRANSFER_KINDS.has(opts.kind);

  if (isTransfer) {
    if (opts.amountUsdsui == null || !Number.isFinite(opts.amountUsdsui)) {
      throw new Error(
        `appendPaymentKitReceipt: kind=${opts.kind} requires amountUsdsui`
      );
    }
    if (opts.amountUsdsui <= 0) {
      throw new Error(
        `appendPaymentKitReceipt: kind=${opts.kind} amount must be positive`
      );
    }
  }

  const amountMicro = isTransfer
    ? BigInt(Math.round((opts.amountUsdsui ?? 0) * 1e6))
    : MARKER_AMOUNT;

  const nonce = buildPaymentKitNonce({
    kind: opts.kind,
    sender,
    receiver,
    refs: opts.refs,
  });

  // Pull the exact USDsui amount from the sender via coinWithBalance, same
  // pattern the SDK uses internally, but driven by us so we can hand the
  // resulting coin straight into a hand-built MoveCall with the EXPLICIT
  // package address (the SDK uses the unresolved MVR literal, see the
  // PAYMENT_KIT_PACKAGE_MAINNET comment above).
  const coin = tx.add(
    coinWithBalance({
      type: USDSUI_TYPE,
      balance: amountMicro,
      useGasCoin: false,
    })
  );

  // Wrap the receiver address in Option::Some via 0x1::option::some<address>.
  // The contract binding declares the receiver as Option<address>; passing
  // a bare address argument would mis-encode at BCS time.
  const receiverOpt = tx.moveCall({
    target: "0x1::option::some",
    typeArguments: ["address"],
    arguments: [tx.pure.address(receiver)],
  });

  // process_registry_payment<T>(registry, nonce, amount, coin, receiver, clock, ctx).
  // `ctx` is auto-supplied by Sui; the binding declares only the 6 args above.
  tx.moveCall({
    package: PAYMENT_KIT_PACKAGE_MAINNET,
    module: "payment_kit",
    function: "process_registry_payment",
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(globalRegistryId()),
      tx.pure.string(nonce),
      tx.pure.u64(amountMicro),
      coin,
      receiverOpt,
      tx.object("0x6"), // Clock, well-known shared object
    ],
  });

  return { nonce };
}
