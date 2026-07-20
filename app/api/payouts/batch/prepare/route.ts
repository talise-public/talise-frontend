import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { randomUUID } from "node:crypto";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { db, userById } from "@/lib/db";
import { checkSendAllowed } from "@/lib/send-limits";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, network } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { screenTransfer } from "@/lib/screening";
import { resolveRecipient } from "@/lib/suins";
import { buildUsdsuiBatchWithReceipts } from "@/lib/payment-kit";
import { buildBatchUsdsuiPayroll } from "@/lib/zkclient";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * POST /api/payouts/batch/prepare
 *
 * "Pay your whole team in one signature." Builds ONE Onara-sponsored PTB that
 * pays every recipient USDsui, atomically (everyone or no one). The two
 * multi-recipient builders already exist; this route wires them to auth,
 * screening, the rolling send-limit gate, resolution, and the sponsored build
 * tail exactly like /api/send/sponsor-prepare.
 *
 * Body: `{ recipients: [{ to, amount, label? }], asset?: "USDsui" }`.
 * Returns `{ batchId, bytes, recipientCount, totalUsd }`. Batch is
 * SPONSORED-ONLY, the gasless rail (single `balance::send_funds`) can't
 * carry a multi-leg PTB, so we skip it entirely.
 */

const MAX_BATCH_RECIPIENTS = 50;
const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

type InputRecipient = { to?: string; amount?: number | string; label?: string };

export async function POST(req: Request) {
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json(
      { error: "ONARA_URL not configured" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  // Per-user rate limit on this money route (anti-abuse / anti-DDoS).
  const rl = await rateLimitAsync({
    key: `payouts-batch-prepare:user:${userId}`,
    limit: 20,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    recipients?: InputRecipient[];
    asset?: string;
    teamName?: string;
    teamId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Optional: which saved team this batch is paying. Stored on the batch so the
  // activity feed can label it "Paid {team}" instead of one recipient's name.
  const teamName = (body.teamName ?? "").trim().slice(0, 60) || null;
  const teamId = (body.teamId ?? "").trim().slice(0, 80) || null;

  const asset = body.asset ?? "USDsui";
  if (asset !== "USDsui") {
    return NextResponse.json(
      { error: "batch payouts settle in USDsui only" },
      { status: 400 }
    );
  }

  const raw = Array.isArray(body.recipients) ? body.recipients : [];
  if (raw.length === 0) {
    return NextResponse.json({ error: "add at least one recipient" }, { status: 400 });
  }
  if (raw.length > MAX_BATCH_RECIPIENTS) {
    return NextResponse.json(
      {
        error: `A batch can pay at most ${MAX_BATCH_RECIPIENTS} recipients at once.`,
        code: "TOO_MANY_RECIPIENTS",
        max: MAX_BATCH_RECIPIENTS,
      },
      { status: 400 }
    );
  }

  // Validate amounts upfront (before any RPC work). Reject empty / non-positive.
  const parsed: { input: string; amount: number; label?: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const input = (r.to ?? "").trim();
    if (!input) {
      return NextResponse.json(
        { error: `Recipient #${i + 1} is missing.`, code: "BAD_RECIPIENT", index: i },
        { status: 400 }
      );
    }
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        {
          error: `Recipient #${i + 1} (${input}) needs a positive amount.`,
          code: "BAD_AMOUNT",
          index: i,
          input,
        },
        { status: 400 }
      );
    }
    const label = (r.label ?? "").trim() || undefined;
    parsed.push({ input, amount, label });
  }

  // ── Resolve EVERY recipient server-side (never trust client addresses) ──
  // If any single resolution fails, reject the whole batch and write NOTHING.
  // Resolution is the slow part (one SuiNS lookup per recipient), so fan the
  // lookups out in PARALLEL, then validate the results in order (the self/dup
  // checks are cheap in-memory passes).
  const selfAddr = user.sui_address.toLowerCase();
  const seen = new Set<string>();
  const resolvedLegs: {
    input: string;
    address: string;
    displayName: string;
    amount: number;
    label?: string;
  }[] = [];
  const resolutions = await Promise.all(
    parsed.map(async (p) => {
      try {
        return await resolveRecipient(p.input);
      } catch {
        return null;
      }
    })
  );
  for (let i = 0; i < parsed.length; i++) {
    const { input, amount, label } = parsed[i];
    const resolved = resolutions[i];
    if (!resolved || !ADDRESS_RE.test(resolved.address)) {
      return NextResponse.json(
        {
          error: `Couldn't resolve recipient #${i + 1} (${input}).`,
          code: "RESOLVE_FAILED",
          index: i,
          input,
        },
        { status: 400 }
      );
    }
    const addr = resolved.address.toLowerCase();
    if (addr === selfAddr) {
      return NextResponse.json(
        {
          error: `Recipient #${i + 1} (${input}) is your own wallet, you can't pay yourself.`,
          code: "SELF_SEND",
          index: i,
          input,
        },
        { status: 400 }
      );
    }
    if (seen.has(addr)) {
      return NextResponse.json(
        {
          error: `Recipient #${i + 1} (${input}) is a duplicate of an earlier recipient.`,
          code: "DUPLICATE_RECIPIENT",
          index: i,
          input,
        },
        { status: 400 }
      );
    }
    seen.add(addr);
    resolvedLegs.push({
      input,
      address: addr,
      displayName: resolved.displayName,
      amount,
      label,
    });
  }

  // Sum to the batch total (rounded to cents, USDsui is 1:1 USD).
  const totalUsd =
    Math.round(resolvedLegs.reduce((acc, r) => acc + r.amount, 0) * 100) / 100;
  if (totalUsd <= 0) {
    return NextResponse.json({ error: "batch total must be positive" }, { status: 400 });
  }

  // ── Compliance screening, HARD STOP, per recipient ─────────────
  // Mirrors sponsor-prepare. Any single hit blocks the WHOLE batch, we never
  // hand back signable bytes for a batch that contains a flagged recipient.
  // Screen every leg in PARALLEL (same fan-out reasoning as resolution), then
  // fail closed if any leg was blocked.
  const screens = await Promise.all(
    resolvedLegs.map((leg) =>
      screenTransfer({
        senderAddr: user.sui_address,
        recipientAddr: leg.address,
        senderName: user.business_name ?? user.name,
        recipientName: null,
      })
    )
  );
  for (let i = 0; i < resolvedLegs.length; i++) {
    const screen = screens[i];
    if (!screen.allow) {
      const leg = resolvedLegs[i];
      console.warn(
        `[payouts/batch/prepare] SCREENING_BLOCK user=${userId} to=${leg.address} cause=${screen.cause} reason=${screen.reason}`
      );
      return NextResponse.json(
        {
          error: "This batch was blocked by a compliance screen.",
          code: "SCREENING_BLOCK",
          reason: screen.reason,
        },
        { status: 403 }
      );
    }
  }

  // ── Hard transaction-limit gate, ONCE for the whole batch total ────
  // The batch is one atomic transfer of `totalUsd` USDsui; gate it as a single
  // send against the rolling daily/monthly cap. `checkSendAllowed` fail-opens.
  const decision = await checkSendAllowed(userId, totalUsd);
  if (!decision.allowed) {
    console.warn(
      `[payouts/batch/prepare] LIMIT_EXCEEDED user=${userId} tier=${decision.tier} ` +
        `window=${decision.window} amount=${totalUsd} used=${decision.used} limit=${decision.limit}`
    );
    return NextResponse.json(
      {
        error: `This batch would exceed your ${decision.window} limit of $${decision.limit?.toLocaleString()}. You've sent $${decision.used?.toLocaleString()} in this window.`,
        code: "LIMIT_EXCEEDED",
        window: decision.window,
        limit: decision.limit,
        used: decision.used,
      },
      { status: 403 }
    );
  }

  // ── Build ONE sponsored PTB ─────────────────────────────────────────
  // Default to the PLAIN payroll builder: a clean `transferObjects` of USDsui
  // to each recipient, all in one atomic Onara-sponsored (gasless) PTB. This is
  // the fast path, no per-recipient registry Move call to build or execute.
  // The Payment Kit receipts builder (a receipt per recipient under the talise
  // registry) is heavier and now OPT-IN via NEXT_PUBLIC_PK_RECEIPTS_ENABLED=true.
  const useReceipts = process.env.NEXT_PUBLIC_PK_RECEIPTS_ENABLED === "true";
  const kind = "payout-batch";
  try {
    const t0 = Date.now();
    const onaraClient = onara();
    const client = sui();
    const net = network();

    // Kick off the two expensive remote lookups in parallel (both memoized).
    const sponsorPromise = memoTtl(
      `onara:status:${onaraUrl}`,
      60_000,
      () => onaraClient.status()
    );
    const gasPricePromise = memoTtl(`sui:gas-price:${net}`, 1_500, async () => {
      const r = await client.getReferenceGasPrice();
      return r.referenceGasPrice;
    });

    const tx = new Transaction();
    tx.setSender(user.sui_address);

    if (useReceipts) {
      buildUsdsuiBatchWithReceipts({
        sender: user.sui_address,
        kind,
        recipients: resolvedLegs.map((r) => ({
          address: r.address,
          amountUsdsui: r.amount,
          label: r.label,
        })),
      }).build(tx);
    } else {
      const build = buildBatchUsdsuiPayroll({
        senderAddress: user.sui_address,
        recipients: resolvedLegs.map((r) => ({
          address: r.address,
          amountMicro: BigInt(Math.round(r.amount * 1e6)),
          ref: r.label,
        })),
      });
      await build(tx);
    }

    // Sponsored tail, exactly like sponsor-prepare's sponsored branch.
    const [{ address: sponsor }, gasPrice] = await Promise.all([
      sponsorPromise,
      gasPricePromise,
    ]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));

    const bytes = await tx.build({ client: client as never });

    // ── Persist the batch + recipient legs (status 'prepared') ───────
    const batchId = `pob_${randomUUID().replace(/-/g, "")}`;
    const now = Date.now();
    const c = db();
    await c.execute({
      sql: `INSERT INTO payout_batches
              (id, user_id, kind, total_usd, recipient_count, status, digest, created_at, team_name, team_id)
            VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, ?)`,
      args: [
        batchId,
        String(userId),
        kind,
        totalUsd,
        resolvedLegs.length,
        now,
        teamName,
        teamId,
      ],
    });
    await Promise.all(
      resolvedLegs.map((leg, i) =>
        c.execute({
          sql: `INSERT INTO payout_batch_recipients
                  (id, batch_id, resolved_address, input_handle, amount_usd, label, idx)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            `pobr_${randomUUID().replace(/-/g, "")}`,
            batchId,
            leg.address,
            leg.input,
            leg.amount,
            leg.label ?? null,
            i,
          ],
        })
      )
    );

    console.log(
      `[payouts/batch/prepare] user=${userId} batch=${batchId} recipients=${resolvedLegs.length} total=${totalUsd} receipts=${useReceipts} build=${Date.now() - t0}ms`
    );

    return NextResponse.json({
      batchId,
      bytes: toBase64(bytes),
      recipientCount: resolvedLegs.length,
      totalUsd,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "build failed";
    console.warn(`[payouts/batch/prepare] user=${userId} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
