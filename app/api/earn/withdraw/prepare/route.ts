import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { userById } from "@/lib/db";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import {
  buildWithdrawUsdsuiMargin,
  fetchSupplierCapId,
} from "@/lib/deepbook-margin";
import { appendNaviWithdraw } from "@/lib/navi-supply";
import { appendPaymentKitReceipt } from "@/lib/intents/wrap-payment-kit";

export const runtime = "nodejs";

/**
 * Per-leg timeout wrapper, mirrors `withTimeout` in `lib/activity.ts`.
 * Duplicated locally (rather than imported) so a stalled NAVI read in
 * the activity feed and a stalled NAVI read here can't share a stack
 * frame and both wedge at once. Returns `fallback` on timeout / error
 * and logs `[earn/withdraw-prepare] <leg> timed out after Nms`.
 */
/**
 * Tagged result so the route can distinguish a TIMEOUT (transient, "try
 * again later" is the right answer) from an ERROR (hard failure, the
 * actual message is the right answer) from OK. The previous
 * implementation collapsed both timeout and rejection into the same
 * fallback value, which meant a NAVI SDK exception ("no NAVI USDsui
 * position", an oracle update failure, etc.) surfaced to iOS as
 * "Withdraw is taking longer than usual, try again in a few seconds."
 *, misleading and unhelpful: retrying didn't fix the underlying error.
 */
type LegResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout"; leg: string; ms: number }
  | { kind: "error"; leg: string; ms: number; message: string };

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  leg: string
): Promise<LegResult<T>> {
  const start = Date.now();
  return new Promise<LegResult<T>>((resolve) => {
    const timer = setTimeout(() => {
      const elapsed = Date.now() - start;
      console.warn(
        `[earn/withdraw-prepare] ${leg} timed out after ${elapsed}ms`
      );
      resolve({ kind: "timeout", leg, ms: elapsed });
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve({ kind: "ok", value: v });
      },
      (e) => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        const message = (e as Error).message ?? String(e);
        console.warn(
          `[earn/withdraw-prepare] ${leg} ERRORED after ${elapsed}ms: ${message}`
        );
        resolve({ kind: "error", leg, ms: elapsed, message });
      }
    );
  });
}

/**
 * Map a verbatim NAVI / chain error string to a user-friendly message.
 * The defaults catch the failure modes we've actually seen in
 * production logs; everything else falls through to a generic copy
 * with the raw detail logged in Vercel for diagnosis.
 */
function mapNaviError(raw: string): string {
  const s = raw.toLowerCase();
  if (/no navi usdsui position/i.test(s) || /no position/i.test(s)) {
    return "You don't have a NAVI position to withdraw from.";
  }
  if (/pyth/i.test(s) || /oracle/i.test(s)) {
    return "NAVI's price oracle update failed. Try again in a few seconds.";
  }
  if (/health/i.test(s) || /under.?collateral/i.test(s)) {
    return "Withdrawal would leave your position undercollateralized. Reduce the amount or repay first.";
  }
  if (/insufficient/i.test(s)) {
    return "Insufficient supplied balance to withdraw that amount. Try a smaller value or 'Withdraw all + rewards'.";
  }
  if (/package|module/i.test(s)) {
    return "NAVI package version mismatch. The Talise team has been notified.";
  }
  return "NAVI rejected the withdraw. Try again or contact support.";
}

/**
 * POST /api/earn/withdraw/prepare
 *
 * Mirror of /api/earn/supply/prepare for the opposite leg. Builds a
 * sponsored-ready PTB that redeems the user's USDsui shares from the
 * chosen venue back to their wallet.
 *
 * Body:
 *   {
 *     venue: "deepbook" | "navi",
 *     // omit to withdraw the entire position (interest + principal)
 *     amount?: number,
 *   }
 * Returns: { transactionKindB64 }, feed straight into /api/zk/sponsor.
 */

const SUPPORTED_VENUES = new Set(["deepbook", "navi"]);

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { venue?: string; amount?: number | string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const venue = (body.venue ?? "deepbook").toLowerCase();
  if (!SUPPORTED_VENUES.has(venue)) {
    return NextResponse.json(
      { error: `venue must be one of ${[...SUPPORTED_VENUES].join(", ")}` },
      { status: 400 }
    );
  }

  // amount is optional. Null / undefined / 0 means "withdraw all".
  // Anything positive is treated as a partial withdrawal in USDsui.
  const amountNum =
    body.amount == null || body.amount === "" ? undefined : Number(body.amount);
  if (amountNum !== undefined && (!Number.isFinite(amountNum) || amountNum < 0)) {
    return NextResponse.json(
      { error: "amount must be a non-negative number, or omit for full withdraw" },
      { status: 400 }
    );
  }

  // Outer 12s cap. iOS APIClient.timeoutIntervalForRequest = 15s, so
  // 12s gives us 3s of headroom to land a clean 504 + the response body
  // before iOS sees an NSURLErrorTimedOut. Was 10s; the NAVI position
  // leg routinely runs 6-7s on a sluggish Sui RPC + Pyth refresh, and
  // the prior 5s/10s pair was too tight (user's screenshot showed the
  // 504 firing on a wallet with a working position).
  const OUTER_CAP_MS = 12_000;
  const TIMEOUT_MARKER = Symbol("withdraw-prepare-outer-timeout");
  let outerTimer: ReturnType<typeof setTimeout> | undefined;
  const outerTimeout = new Promise<typeof TIMEOUT_MARKER>((resolve) => {
    outerTimer = setTimeout(() => resolve(TIMEOUT_MARKER), OUTER_CAP_MS);
  });

  const work = (async () => {
    const t0 = Date.now();
    let tPosition = t0;
    let tBuild = t0;
    try {
      const tx = new Transaction();
      tx.setSender(user.sui_address);

      if (venue === "navi") {
        // NAVI withdraw refreshes the Pyth oracle in the same PTB
        // (required for the position-health check). `undefined` =
        // "withdraw the full supplied amount", the adapter reads the
        // user's live position internally.
        //
        // `appendNaviWithdraw` is the slow leg in the wild, its
        // internal position lookup + Pyth refresh can take 4-8s on a
        // sluggish RPC. Was 5s; bumped to 9s so a normal-but-slow
        // NAVI read doesn't trip the inner cap. Still ≤ outer 12s cap
        // and ≤ iOS 15s URLSession request budget. On miss, the route
        // surfaces a clean 504 below rather than letting iOS hit its
        // URLSession default.
        const wrappedAmount =
          amountNum && amountNum > 0 ? amountNum : undefined;
        const res = await withTimeout(
          appendNaviWithdraw(tx, user.sui_address, wrappedAmount).then(
            () => true
          ),
          9_000,
          "navi-position"
        );
        tPosition = Date.now();
        if (res.kind === "timeout") {
          return NextResponse.json(
            {
              error:
                "NAVI is responding slowly. Try again in a few seconds.",
              code: "NAVI_TIMEOUT",
            },
            { status: 504 }
          );
        }
        if (res.kind === "error") {
          // Surface the actual NAVI failure to iOS verbatim (truncated)
          // instead of pretending it was a transient timeout. Common
          // shapes: "no NAVI USDsui position to withdraw" (user has 0
          // supplied), Pyth oracle update failure, position-health
          // check fail, package address mismatch, etc.
          const friendly = mapNaviError(res.message);
          return NextResponse.json(
            {
              error: friendly,
              detail: res.message.slice(0, 400),
              code: "NAVI_WITHDRAW_FAILED",
            },
            { status: 502 }
          );
        }
      } else {
        const capRes = await withTimeout(
          fetchSupplierCapId(user.sui_address),
          5_000,
          "deepbook-cap"
        );
        tPosition = Date.now();
        if (capRes.kind === "timeout") {
          return NextResponse.json(
            {
              error: "DeepBook is responding slowly. Try again in a few seconds.",
              code: "DEEPBOOK_TIMEOUT",
            },
            { status: 504 }
          );
        }
        const capId =
          capRes.kind === "ok" ? capRes.value : null;
        if (!capId) {
          return NextResponse.json(
            { error: "you don't have a DeepBook position to withdraw" },
            { status: 404 }
          );
        }
        buildWithdrawUsdsuiMargin({
          senderAddress: user.sui_address,
          supplierCapId: capId,
          amountUsdsui: amountNum && amountNum > 0 ? amountNum : undefined,
        }).build(tx);
      }

      // Universal Talise receipt, see /api/earn/supply/prepare for the
      // full rationale. The venue's withdraw MoveCalls above redeem the
      // position; this 1-micro self-ping just tags the tx with a typed
      // memo so the activity classifier can render "Withdrew from Navi"
      // authoritatively from the PaymentRecord nonce.
      const { nonce } = appendPaymentKitReceipt(tx, {
        kind: "withdraw",
        sender: user.sui_address,
        refs: { venue },
      });

      const buildRes = await withTimeout(
        tx.build({
          client: sui() as never,
          onlyTransactionKind: true,
        }),
        5_000,
        "tx-build"
      );
      tBuild = Date.now();
      if (buildRes.kind === "timeout") {
        return NextResponse.json(
          {
            error:
              "Building the withdraw transaction is taking longer than usual. Try again in a few seconds.",
            code: "BUILD_TIMEOUT",
          },
          { status: 504 }
        );
      }
      if (buildRes.kind === "error") {
        return NextResponse.json(
          {
            error: "Couldn't build the withdraw transaction.",
            detail: buildRes.message.slice(0, 400),
            code: "BUILD_FAILED",
          },
          { status: 502 }
        );
      }
      const kind = buildRes.value;

      console.log(
        `[earn/withdraw-prepare] position=${tPosition - t0}ms rewards=0ms build=${tBuild - tPosition}ms total=${tBuild - t0}ms venue=${venue}`
      );
      // Verification log, per the 2026-05-29 sponsorship-matrix directive.
      // gasOwner + gasPrice get set in /api/zk/sponsor (see its log line
      // with the full `mode=sponsored sponsor=<addr> gasPrice=<n>` shape).
      console.log(
        `[earn/withdraw-prepare] mode=sponsored venue=${venue} amount=${amountNum ?? "all"}`
      );

      return NextResponse.json({
        transactionKindB64: toBase64(kind),
        venue,
        amount: amountNum ?? null,
        withdrawAll: !amountNum,
        receiptNonce: nonce,
      });
    } catch (err) {
      return NextResponse.json(
        { error: "build failed: " + (err as Error).message },
        { status: 500 }
      );
    }
  })();

  const winner = await Promise.race([work, outerTimeout]);
  if (outerTimer) clearTimeout(outerTimer);
  if (winner === TIMEOUT_MARKER) {
    console.warn(
      `[earn/withdraw-prepare] outer cap fired at ${OUTER_CAP_MS}ms (user=${userId}, venue=${venue})`
    );
    return NextResponse.json(
      {
        error:
          "Withdraw is taking longer than usual, try again in a few seconds.",
      },
      { status: 504 }
    );
  }
  return winner as NextResponse;
}
