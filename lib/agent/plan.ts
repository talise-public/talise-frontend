import "server-only";

import type { ChatStep } from "@/lib/chat/intent";
import { stepLabel, isReadOnly } from "@/lib/chat/intent";
import { resolveRecipient } from "@/lib/suins";
import { screenTransfer } from "@/lib/screening";
import { checkSendAllowed } from "@/lib/send-limits";
import { cashoutFeatureOpen, checkDailyOfframpCap } from "@/lib/linq";
import { getPrimaryBankAccount, last4 } from "@/lib/bank-accounts";
import { displayRatePerUsd } from "@/lib/display-fx";
import { FX, type Currency } from "@/lib/fx";
import type { User } from "@/lib/db";

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Compact local-currency label, e.g. "₦1,000". */
function localLabel(amount: number, currency: string): string {
  const sym: Record<string, string> = { NGN: "₦", USD: "$", GHS: "₵", KES: "KSh", ZAR: "R" };
  const s = sym[currency.toUpperCase()] ?? "";
  return `${s}${Math.round(amount).toLocaleString()}${s ? "" : " " + currency.toUpperCase()}`;
}

/**
 * The Talise Agent's safety brain: take a PROPOSED intent (steps the LLM emitted)
 * and return a VALIDATED, priced preview, resolving recipients, screening them,
 * and checking the user's send cap, WITHOUT moving any money. The client renders
 * this as a confirm card; only on a user slide does it call the real prepare +
 * sign endpoints. "Agent proposes → server validates → human confirms."
 *
 * Nothing here signs, sponsors, or broadcasts. It is pure validation + preview.
 */

const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

export type PlannedStep = {
  kind: ChatStep["kind"];
  label: string;
  /** ok = safe to confirm · read_only = run inline · blocked = a hard stop · needs_info = missing/invalid param. */
  status: "ok" | "read_only" | "blocked" | "needs_info";
  detail?: string;
  /** Resolved recipient (send steps only). */
  resolved?: { address: string; displayName: string };
  /** USD this step moves out of the wallet (send/save/withdraw); 0 for read-only. */
  amountUsd?: number;
};

export type AgentPlan = {
  /** True only if every step is ok/read_only and the cap check passes. */
  confirmable: boolean;
  steps: PlannedStep[];
  /** Total USD leaving the wallet across send steps (cap is checked on this). */
  totalSendUsd: number;
  /** Present when the send total would breach a tier cap. */
  limit?: { window: "daily" | "monthly"; limit: number; used: number; tier: number };
  /** A short human summary for the confirm card header. */
  summary: string;
};

/**
 * Validate + price an intent for a user. Read-only steps echo back as `read_only`.
 * Send steps resolve + screen + accumulate toward the cap check. Other write steps
 * (save/withdraw/swap/claim) are amount-validated only (they sign client-side).
 */
export async function planIntent(user: User, steps: ChatStep[]): Promise<AgentPlan> {
  const selfAddr = user.sui_address.toLowerCase();
  const senderName = user.business_name ?? user.name ?? null;
  const planned: PlannedStep[] = [];
  let totalSendUsd = 0;

  // Resolve every send recipient in parallel (the slow part), then validate in order.
  const sendIdx = steps
    .map((s, i) => (s.kind === "send" ? i : -1))
    .filter((i) => i >= 0);
  const resolutions = await Promise.all(
    sendIdx.map(async (i) => {
      const s = steps[i] as Extract<ChatStep, { kind: "send" }>;
      try {
        return await resolveRecipient(s.recipient);
      } catch {
        return null;
      }
    })
  );
  const resolvedByStep = new Map<number, { address: string; displayName: string } | null>();
  sendIdx.forEach((i, k) => resolvedByStep.set(i, resolutions[k]));

  // Screen all resolved send recipients in parallel.
  const screenInputs = sendIdx
    .map((i) => resolvedByStep.get(i))
    .filter((r): r is { address: string; displayName: string } => !!r && ADDRESS_RE.test(r.address));
  const screens = await Promise.all(
    screenInputs.map((r) =>
      screenTransfer({ senderAddr: user.sui_address, recipientAddr: r.address, senderName, recipientName: null })
    )
  );
  const screenByAddr = new Map<string, boolean>();
  screenInputs.forEach((r, k) => screenByAddr.set(r.address.toLowerCase(), screens[k].allow));

  // Resolve a live rate for every local currency the agent attached, so we can
  // compute the EXACT usd from what the user actually said ("1000 naira"),
  // instead of trusting a cents-rounded `amount` that drifts on the round-trip.
  const localCcys = new Set<string>();
  for (const s of steps) {
    const la = (s as { localAmount?: number }).localAmount;
    const lc = (s as { localCurrency?: string }).localCurrency;
    if (typeof la === "number" && la > 0 && lc) localCcys.add(lc.toUpperCase());
  }
  const rateByCcy = new Map<string, number>();
  await Promise.all(
    [...localCcys].map(async (ccy) => {
      if (!(ccy in FX)) return; // only known Talise currencies
      const rate = await displayRatePerUsd(ccy as Currency).catch(() => null);
      if (rate && rate > 0) rateByCcy.set(ccy, rate);
    })
  );

  /** Exact usd for a step: localAmount/rate at full precision when present, else `amount`. */
  function resolveUsd(step: ChatStep): { usd: number; local?: { amount: number; currency: string } } {
    const la = (step as { localAmount?: number }).localAmount;
    const lc = (step as { localCurrency?: string }).localCurrency?.toUpperCase();
    const fallback = Number((step as { amount?: number }).amount);
    if (typeof la === "number" && la > 0 && lc) {
      const rate = rateByCcy.get(lc);
      if (rate && rate > 0) return { usd: r6(la / rate), local: { amount: la, currency: lc } };
    }
    return { usd: fallback };
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = stepLabel(step);

    if (isReadOnly(step)) {
      planned.push({ kind: step.kind, label, status: "read_only", amountUsd: 0 });
      continue;
    }

    if (step.kind === "send") {
      const { usd: amt, local } = resolveUsd(step);
      if (!Number.isFinite(amt) || amt <= 0) {
        planned.push({ kind: step.kind, label, status: "needs_info", detail: "Enter a positive amount." });
        continue;
      }
      const r = resolvedByStep.get(i);
      if (!r || !ADDRESS_RE.test(r.address)) {
        planned.push({ kind: step.kind, label, status: "needs_info", detail: `Couldn't find "${step.recipient}".` });
        continue;
      }
      if (r.address.toLowerCase() === selfAddr) {
        planned.push({ kind: step.kind, label, status: "blocked", detail: "That's your own wallet." });
        continue;
      }
      if (screenByAddr.get(r.address.toLowerCase()) === false) {
        planned.push({ kind: step.kind, label, status: "blocked", detail: "Blocked by a compliance screen." });
        continue;
      }
      totalSendUsd += amt;
      planned.push({
        kind: step.kind,
        label: local
          ? `Send ${localLabel(local.amount, local.currency)} (~$${amt.toFixed(2)}) → ${r.displayName}`
          : `Send $${amt.toFixed(2)} → ${r.displayName}`,
        status: "ok",
        resolved: r,
        amountUsd: amt,
      });
      continue;
    }

    // cash_out, move USDsui to the user's linked NGN bank (Linq off-ramp).
    // Gated on the feature flag, a linked primary bank, and the daily cap.
    if (step.kind === "cash_out") {
      const { usd: amt, local } = resolveUsd(step);
      if (!Number.isFinite(amt) || amt <= 0) {
        planned.push({ kind: step.kind, label, status: "needs_info", detail: "Enter a positive amount." });
        continue;
      }
      if (!cashoutFeatureOpen()) {
        planned.push({ kind: step.kind, label, status: "blocked", detail: "Cash out is paused right now." });
        continue;
      }
      const bank = await getPrimaryBankAccount(user.id).catch(() => null);
      if (!bank) {
        planned.push({ kind: step.kind, label, status: "needs_info", detail: "Link a bank account first: Ramps, then Cash out." });
        continue;
      }
      const cap = await checkDailyOfframpCap(user.id, amt).catch(() => null);
      if (cap && !cap.ok) {
        planned.push({ kind: step.kind, label, status: "blocked", detail: cap.error ?? `Capped at $${cap.max} a day.` });
        continue;
      }
      planned.push({
        kind: step.kind,
        label: local
          ? `Cash out ${localLabel(local.amount, local.currency)} (~$${amt.toFixed(2)}) to your bank`
          : `Cash out $${amt.toFixed(2)} to your bank`,
        status: "ok",
        amountUsd: amt,
        detail: `To your bank account ending ${last4(bank.account_number)}`,
      });
      continue;
    }

    // request, create a shareable payment link (no signing, no money moves).
    if (step.kind === "request") {
      const { usd: amt, local } = resolveUsd(step);
      if (!Number.isFinite(amt) || amt <= 0) {
        planned.push({ kind: step.kind, label, status: "needs_info", detail: "How much should the link be for?" });
        continue;
      }
      planned.push({
        kind: step.kind,
        label: local
          ? `Request ${localLabel(local.amount, local.currency)} (~$${amt.toFixed(2)})${step.note ? ` for ${step.note}` : ""}`
          : `Request $${amt.toFixed(2)}${step.note ? ` for ${step.note}` : ""}`,
        status: "ok",
        amountUsd: amt,
        detail: "Creates a shareable payment link.",
      });
      continue;
    }

    // save / withdraw / swap / claim_rewards, amount sanity only (signed client-side).
    const { usd: amt } = resolveUsd(step);
    if (step.kind !== "claim_rewards" && (!Number.isFinite(amt) || amt <= 0)) {
      planned.push({ kind: step.kind, label, status: "needs_info", detail: "Enter a positive amount." });
      continue;
    }
    planned.push({ kind: step.kind, label, status: "ok", amountUsd: step.kind === "save" || step.kind === "withdraw" ? amt : 0 });
  }

  // One cap check for the whole send total (the batch is one outflow).
  let limit: AgentPlan["limit"];
  if (totalSendUsd > 0) {
    const decision = await checkSendAllowed(user.id, totalSendUsd);
    if (!decision.allowed) {
      limit = { window: decision.window, limit: decision.limit, used: decision.used, tier: decision.tier };
      // Mark the send steps blocked.
      for (const p of planned) {
        if (p.kind === "send" && p.status === "ok") {
          p.status = "blocked";
          p.detail = `Over your ${decision.window} limit ($${decision.limit.toLocaleString()}).`;
        }
      }
    }
  }

  const hasBlock = planned.some((p) => p.status === "blocked" || p.status === "needs_info");
  const confirmable = !hasBlock && planned.some((p) => p.status === "ok");

  return {
    confirmable,
    steps: planned,
    totalSendUsd: Math.round(totalSendUsd * 100) / 100,
    limit,
    summary: buildSummary(planned, totalSendUsd, limit),
  };
}

function buildSummary(steps: PlannedStep[], total: number, limit: AgentPlan["limit"]): string {
  if (limit) return `This would exceed your ${limit.window} limit of $${limit.limit.toLocaleString()}.`;
  const blocked = steps.find((s) => s.status === "blocked" || s.status === "needs_info");
  if (blocked) return blocked.detail ?? "Some steps need attention.";
  const writes = steps.filter((s) => s.status === "ok").length;
  const reads = steps.filter((s) => s.status === "read_only").length;
  if (writes === 0 && reads > 0) return "Ready to show your info.";
  if (total > 0) return `Ready to confirm: $${total.toFixed(2)} total, gasless.`;
  return "Ready to confirm. Gasless.";
}
