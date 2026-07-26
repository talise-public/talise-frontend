import "server-only";

import { randomUUID } from "node:crypto";

import { db, ensureSchema } from "@/lib/db";
import { createOrder, getRate, isUsdsuiCoinType } from "@/lib/linq";

import { ProviderRequestError, ProviderUnavailableError } from "./breaker";
import { CORRIDOR_DEGRADED_MESSAGE, DEPOSIT_WINDOW_MS } from "./config";
import { checkDailyOfframpCapAllRails } from "./caps";
import {
  claimIntent,
  completeIntent,
  fingerprintKey,
  intentKey,
  recordAttempt,
  releaseIntent,
} from "./store";

/**
 * The ONE hardened implementation of "create a Linq NGN payout order".
 *
 * WHY THIS EXISTS
 * ---------------
 * Three routes (`/api/offramp/linq/create`, `/api/offramp/linq/to-user`,
 * `/api/agent/cashout/prepare`) each had their own copy of this ~80-line
 * sequence. The copies had DRIFTED, and the drift was a money bug: `create`
 * failed CLOSED when it couldn't persist the order, while `to-user` logged a
 * warning and handed the deposit wallet back anyway. A user funding that order
 * was invisible to us: not pollable (no row → 404 from /status), not counted
 * against the daily cap, not reconcilable, and with no record that they were
 * ever owed a refund. One implementation, one behaviour.
 *
 * ORDER OF OPERATIONS (each step exists for a specific failure)
 * ------------------------------------------------------------
 *  1. Cap check across ALL rails, before anything is created.
 *  2. CLAIM an idempotency key. A client retry after a timeout replays the
 *     original order instead of creating a second one with a second deposit
 *     address (which a retrying client could fund twice).
 *  3. Create the order at the provider, with the SAME key as the provider-side
 *     idempotency key, so even a lost claim row can't double-pay.
 *  4. Verify the coin. Never hand back a deposit address for an order the
 *     provider is watching for a different coin.
 *  5. PERSIST, FAIL CLOSED. If we cannot record it, we refuse to reveal the
 *     deposit address. No address means no funds moved means nothing to unwind.
 *  6. Ledger the attempt (cross-rail) and complete the claim.
 */

export interface BeginLinqOrderInput {
  /** The user who will be DEBITED (the sender), and whose cap applies. */
  userId: string | number;
  /** Sender's Sui address. Used as the provider's auto-refund target. */
  senderAddress: string;
  /** Cash-out denominated in NGN (the recipient is credited this), or … */
  amountNgn?: number;
  /** … denominated in USDsui (the amount debited). Exactly one is required. */
  amountUsdsui?: number;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  /** Client-supplied idempotency key (header or body). Strongly recommended. */
  clientIdempotencyKey?: string;
  /** For logs, e.g. "create" | "to-user". */
  source: string;
}

export interface LinqOrderSuccess {
  ok: true;
  /** Our `linq_offramps` row id. */
  orderId: string;
  linqOrderId: string;
  walletAddress: string;
  coinType: string;
  /** EXACT amount to send so the recipient is credited `amountNgn`. */
  amountUsdsui: number;
  amountNgn: number;
  rate: number;
  depositWindowMinutes: number;
  /** True when this call replayed an earlier, identical request. */
  replayed: boolean;
}

export interface LinqOrderFailure {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

export type BeginLinqOrderResult = LinqOrderSuccess | LinqOrderFailure;

const r6 = (n: number) => Math.round(n * 1e6) / 1e6; // USDsui = 6 dp
const r2 = (n: number) => Math.round(n * 100) / 100; // NGN = 2 dp

export async function beginLinqOrder(
  input: BeginLinqOrderInput
): Promise<BeginLinqOrderResult> {
  const wantsNgn = Number.isFinite(input.amountNgn) && (input.amountNgn ?? 0) > 0;
  const wantsUsdsui =
    Number.isFinite(input.amountUsdsui) && (input.amountUsdsui ?? 0) > 0;
  if (!wantsNgn && !wantsUsdsui) {
    return {
      ok: false,
      status: 400,
      body: { error: "amountNgn or amountUsdsui must be positive" },
    };
  }

  // ── 1. Estimate the stablecoin leg ────────────────────────────────────
  // For an NGN-denominated cash-out we estimate from the display rate; the
  // EXACT figure comes from the order's LOCKED rate below.
  let initialUsdsui = wantsUsdsui ? r6(input.amountUsdsui!) : 0;
  if (wantsNgn && !wantsUsdsui) {
    try {
      const rateNow = (await getRate()).rate;
      if (!Number.isFinite(rateNow) || rateNow <= 0) throw new Error("bad rate");
      initialUsdsui = r6(input.amountNgn! / rateNow);
    } catch (e) {
      return degradedOr(e, { error: "rate_unavailable" }, 503);
    }
  }

  // ── 2. Daily cap, ALL rails ───────────────────────────────────────────
  const cap = await checkDailyOfframpCapAllRails(input.userId, initialUsdsui);
  if (!cap.ok) {
    return {
      ok: false,
      status: cap.code === "CAP_CHECK_UNAVAILABLE" ? 503 : 400,
      body: {
        error: cap.error,
        code: cap.code,
        maxUsd: cap.max,
        usedToday: cap.used,
        remainingToday: cap.remaining,
      },
    };
  }

  // ── 3. Claim the idempotency key ──────────────────────────────────────
  const key = input.clientIdempotencyKey
    ? intentKey({
        userId: input.userId,
        corridor: "NGN",
        clientKey: input.clientIdempotencyKey,
      })
    : // No client key: bucket the intent so a retry within ~2 minutes collapses
      // onto the original order, while a deliberate repeat payment later still
      // gets its own. iOS/CLI should send an explicit key; see the doc.
      fingerprintKey({
        userId: input.userId,
        corridor: "NGN",
        amount: initialUsdsui,
        destination: `bank:${input.bankCode}:${input.accountNumber}`,
      });

  const claim = await claimIntent({
    key,
    userId: input.userId,
    provider: "linq",
    corridor: "NGN",
  });
  if (!claim.claimed) {
    const replay = claim.existing.response;
    if (replay && typeof replay.walletAddress === "string") {
      console.log(
        `[offramp/${input.source}] replaying idempotent order for user=${input.userId} key=${key}`
      );
      return { ...(replay as unknown as LinqOrderSuccess), ok: true, replayed: true };
    }
    // Claimed but not yet completed: a concurrent identical request is in
    // flight. Refuse rather than race it into a second provider order.
    return {
      ok: false,
      status: 409,
      body: {
        error: "A cash-out with the same details is already being processed.",
        code: "DUPLICATE_IN_FLIGHT",
      },
    };
  }

  const rowId: string = randomUUID();
  const now = Date.now();

  // ── 4. Create the order at the provider ───────────────────────────────
  let order;
  try {
    order = await createOrder({
      amountStableCoin: initialUsdsui,
      bankAccount: input.accountNumber,
      bankCode: input.bankCode,
      bankName: input.bankName,
      accountName: input.accountName,
      // Auto-refund target if the bank payout fails. ALWAYS the address that
      // funds the deposit, never the recipient's.
      refundAddress: input.senderAddress,
      customerRef: String(input.userId),
      // The claimed key IS the provider key: a retry returns the ORIGINAL order
      // (same deposit address, same amount) instead of a second payout.
      idempotencyKey: key,
    });
  } catch (e) {
    await releaseIntent(key, "provider rejected order creation");
    const reason = (e as Error).message ?? "provider rejected the order";
    console.warn(`[offramp/${input.source}] createOrder failed:`, reason);
    return degradedOr(
      e,
      { error: "Could not start the cash-out.", reason },
      502
    );
  }

  // ── 5. Coin guard ─────────────────────────────────────────────────────
  if (!isUsdsuiCoinType(order.coinType)) {
    await releaseIntent(key, "coin mismatch");
    console.warn(`[offramp/${input.source}] unexpected coinType:`, order.coinType);
    return {
      ok: false,
      status: 502,
      body: { error: "Could not start the cash-out.", reason: "off-ramp coin mismatch" },
    };
  }

  // Send EXACTLY what the provider recorded on the order: that is the amount its
  // deposit watcher matches. Recomputing from the locked rate drifted whenever
  // the rate ticked between the rate fetch and create, so the deposit was never
  // recognized → timeout → failed payout.
  const lockedRate =
    order.rate > 0 ? order.rate : order.amountNGN / Math.max(initialUsdsui, 1e-6);
  const sendUsdsui = r6(
    order.amountStableCoin > 0 ? order.amountStableCoin : initialUsdsui
  );
  const creditNgn = r2(
    order.amountNGN > 0 ? order.amountNGN : sendUsdsui * lockedRate
  );

  // ── 6. Persist. FAIL CLOSED, and never double-insert ──────────────────
  let effectiveRowId = rowId;
  try {
    await ensureSchema();
    const c = db();
    // Insert only if this provider order isn't already recorded. A provider that
    // honours idempotency returns the SAME order id for a retry, and a second
    // row for it would double-count the user's daily cap. Kept as ONE statement
    // so the check and the write cannot interleave.
    //
    // The explicit casts are required: in `INSERT … SELECT $1, $2, …` Postgres
    // analyses the SELECT before it knows the target columns, so bare parameters
    // would fail with "could not determine data type of parameter".
    await c.execute({
      sql: `INSERT INTO linq_offramps
              (id, linq_order_id, user_id, amount_usdsui, amount_ngn, rate,
               bank_code, bank_account_number, bank_account_name,
               wallet_address, status, created_at, updated_at)
            SELECT ?::text, ?::text, ?::text, ?::numeric, ?::numeric, ?::numeric,
                   ?::text, ?::text, ?::text, ?::text, 'initiated', ?::bigint, ?::bigint
             WHERE NOT EXISTS (
               SELECT 1 FROM linq_offramps WHERE linq_order_id = ?::text
             )`,
      args: [
        rowId,
        order.id,
        String(input.userId),
        sendUsdsui,
        creditNgn,
        lockedRate,
        input.bankCode,
        input.accountNumber,
        input.accountName,
        order.walletAddress,
        now,
        now,
        order.id,
      ],
    });
    const existing = await c.execute({
      sql: `SELECT id FROM linq_offramps WHERE linq_order_id = ? LIMIT 1`,
      args: [order.id],
    });
    const foundId = existing.rows[0]?.id as string | undefined;
    if (!foundId) throw new Error("row not readable after insert");
    effectiveRowId = foundId;
  } catch (e) {
    // FAIL CLOSED. The provider order exists but we could not record it. Handing
    // back the deposit wallet would let the user fund an order we cannot
    // reconcile, refund, or count against their cap. Refuse: no funds have
    // moved, and the orphaned order (logged with its id) holds no user funds.
    await releaseIntent(key, "persist failed");
    console.error(
      `[offramp/${input.source}] persist failed, refusing to return deposit wallet. ` +
        `Orphaned provider order=${order.id} user=${input.userId}:`,
      (e as Error).message
    );
    return {
      ok: false,
      status: 500,
      body: {
        error: "Could not record your cash-out. No funds were moved, please try again.",
      },
    };
  }

  const success: LinqOrderSuccess = {
    ok: true,
    orderId: effectiveRowId,
    linqOrderId: order.id,
    walletAddress: order.walletAddress,
    coinType: order.coinType,
    amountUsdsui: sendUsdsui,
    amountNgn: creditNgn,
    rate: lockedRate,
    depositWindowMinutes: Math.round(DEPOSIT_WINDOW_MS / 60_000),
    replayed: false,
  };

  // ── 7. Cross-rail ledger + complete the claim ─────────────────────────
  // Best-effort: the customer-visible record (step 6) already exists, so a
  // hiccup here degrades observability, not correctness.
  try {
    await recordAttempt({
      id: effectiveRowId,
      userId: input.userId,
      provider: "linq",
      corridor: "NGN",
      usdAmount: sendUsdsui,
      destAmount: creditNgn,
      providerRef: order.id,
      depositAddress: order.walletAddress,
      state: "awaiting_deposit",
    });
  } catch (e) {
    console.warn(`[offramp/${input.source}] attempt ledger failed:`, (e as Error).message);
  }
  try {
    await completeIntent({
      key,
      ourRef: effectiveRowId,
      providerRef: order.id,
      response: success as unknown as Record<string, unknown>,
    });
  } catch (e) {
    console.warn(`[offramp/${input.source}] completeIntent failed:`, (e as Error).message);
  }

  return success;
}

/**
 * Turn a provider error into the right HTTP shape. A degraded corridor is a 503
 * with a distinct code, NOT a 502: the client should tell the user to try later
 * and MUST NOT retry immediately into a rail we already know is down.
 */
function degradedOr(
  e: unknown,
  fallbackBody: Record<string, unknown>,
  fallbackStatus: number
): LinqOrderFailure {
  if (e instanceof ProviderUnavailableError) {
    console.error(`[offramp] corridor degraded: ${e.message} (${e.detail ?? "-"})`);
    return {
      ok: false,
      status: 503,
      body: {
        error: CORRIDOR_DEGRADED_MESSAGE,
        code: "CORRIDOR_DEGRADED",
      },
    };
  }
  if (e instanceof ProviderRequestError) {
    return {
      ok: false,
      status: 422,
      body: { error: "The payout details were rejected.", reason: e.message },
    };
  }
  return { ok: false, status: fallbackStatus, body: fallbackBody };
}

/**
 * Read a client idempotency key from a request. Accepts the standard
 * `Idempotency-Key` header (preferred) or an `idempotencyKey` body field.
 */
export function readIdempotencyKey(
  req: Request,
  body?: { idempotencyKey?: unknown }
): string | undefined {
  const header = req.headers.get("idempotency-key") ?? req.headers.get("x-idempotency-key");
  const raw =
    (typeof header === "string" && header.trim()) ||
    (typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim()) ||
    "";
  if (!raw) return undefined;
  // Bound it: the value is hashed into a primary key, so cap the input size and
  // keep it to safe characters.
  if (raw.length > 128 || !/^[\w.:-]+$/.test(raw)) return undefined;
  return raw;
}
