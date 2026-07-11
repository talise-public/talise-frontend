"use client";

/**
 * Renders a parsed Talise Agent intent beneath the assistant's message — the
 * web twin of the iOS `AgentIntentCard`.
 *
 *   • Read-only intents (balance / yield / activity) auto-run inline on mount
 *     and show their result lines — no slide, no signing.
 *   • Write intents POST `/api/agent/plan` to validate + price, render a
 *     per-step preview, and gate execution behind simple Accept / Decline
 *     buttons — the server only marks a plan `confirmable` when it's safe.
 *
 * "Agent proposes → server validates → human confirms." Execution NEVER trusts
 * the model's proposed amount/recipient: send legs use the SERVER-resolved
 * `resolved.address` + `amountUsd` from the plan response (same hardening as
 * `AgentExecutor.swift`). Money moves only through the same prepare→sign→submit
 * hooks the manual Pay / Earn flows use, so every guardrail is already enforced.
 */

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  AlertCircleIcon,
  EyeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  api,
  PrimaryButton,
  Spinner,
  useToast,
  useCurrency,
  useSignAndSend,
  type Balances,
  type ActivityEntry,
} from "@/components/app";
import { useEarnAction, type EarnVenue } from "@/components/app/earn/useEarnAction";
import { friendlyError } from "@/components/app/cheques/signBytes";
import type { ChatIntent, ChatStep, YieldVenueId } from "@/lib/chat/intent";

// ── DTOs (mirror `AgentPlan` in lib/agent/plan.ts; that module is server-only
//    so we re-declare the wire shape here rather than import it). ───────────
type PlannedStepDTO = {
  kind: ChatStep["kind"];
  label: string;
  status: "ok" | "read_only" | "blocked" | "needs_info";
  detail?: string;
  /** Resolved recipient (send steps only) — what the executor sends to. */
  resolved?: { address: string; displayName: string };
  /** USD this step moves out of the wallet (send/save/withdraw); 0 read-only. */
  amountUsd?: number;
};

type AgentPlanDTO = {
  confirmable: boolean;
  steps: PlannedStepDTO[];
  totalSendUsd: number;
  limit?: { window: "daily" | "monthly"; limit: number; used: number; tier: number };
  summary: string;
};

type Stage = "loading" | "readOnly" | "plan" | "running" | "done" | "failed" | "declined";

export function AgentIntentCard({ intent }: { intent: ChatIntent }) {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const { send } = useSignAndSend();
  const { supply, withdraw, withdrawEarned } = useEarnAction();

  const [stage, setStage] = useState<Stage>("loading");
  const [plan, setPlan] = useState<AgentPlanDTO | null>(null);
  const [resultLines, setResultLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const readOnlyOnly =
    intent.steps.length > 0 && intent.steps.every(isReadOnlyStep);

  // Kick the intent once on mount: read-only intents fetch + format inline;
  // write intents validate + price through the plan endpoint.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    if (readOnlyOnly) {
      try {
        setResultLines(await runReadOnly(intent.steps, formatUsd));
        setStage("readOnly");
      } catch (e) {
        setError(friendlyError(e, "Couldn't load that right now."));
        setStage("failed");
      }
      return;
    }
    try {
      const p = await api<AgentPlanDTO>("/api/agent/plan", {
        method: "POST",
        body: { steps: intent.steps },
      });
      setPlan(p);
      setStage("plan");
    } catch (e) {
      setError(friendlyError(e, "Couldn't check that plan right now."));
      setPlan({ confirmable: false, steps: [], totalSendUsd: 0, summary: "Couldn't check this plan." });
      setStage("failed");
    }
  }

  // Execute every `ok` write step of the validated plan, in order. We read the
  // venue / fallback from the ORIGINAL intent (same length + order as
  // plan.steps), but money always moves against the SERVER-validated values.
  async function confirm() {
    if (!plan || stage === "running") return;
    setStage("running");
    setError(null);
    try {
      const lines: string[] = [];
      for (let i = 0; i < plan.steps.length; i++) {
        const p = plan.steps[i];
        if (p.status !== "ok") continue;
        const step = intent.steps[i];

        switch (p.kind) {
          case "send": {
            // Defense-in-depth: send ONLY to the server-resolved, screened
            // recipient + the server-validated amount — never the model's raw
            // proposal. Skip an "ok" step the server didn't fully resolve.
            const to = p.resolved?.address;
            const amount = p.amountUsd;
            if (!to || !amount || amount <= 0) continue;
            await send({ to, amountUsd: amount });
            lines.push(`Sent ${formatUsd(amount)} to ${p.resolved?.displayName ?? shortAddr(to)}.`);
            break;
          }
          case "save": {
            const amount = p.amountUsd ?? stepAmount(step) ?? 0;
            if (amount <= 0) continue;
            const venue = (stepVenue(step) ?? "navi") as EarnVenue;
            await supply(venue, amount);
            lines.push(`Saved ${formatUsd(amount)} into ${displayVenue(venue)}.`);
            break;
          }
          case "withdraw": {
            const amount = p.amountUsd ?? stepAmount(step) ?? 0;
            if (amount <= 0) continue;
            const venue = (stepVenue(step) ?? "navi") as EarnVenue;
            await withdraw(venue, amount);
            lines.push(`Withdrew ${formatUsd(amount)} from ${displayVenue(venue)}.`);
            break;
          }
          case "claim_rewards": {
            await withdrawEarned();
            lines.push("Claimed your NAVI rewards.");
            break;
          }
          case "cash_out": {
            const amount = p.amountUsd;
            if (!amount || amount <= 0) continue;
            // Server loads the linked bank + creates the Linq order; we sign a
            // sponsored send to the deposit wallet and Linq pays the bank.
            const prep = await api<{ walletAddress: string; amountUsdsui: number; bankLast4?: string }>(
              "/api/agent/cashout/prepare",
              { method: "POST", body: { amountUsd: amount } }
            );
            await send({ to: prep.walletAddress, amountUsd: prep.amountUsdsui });
            const dest = prep.bankLast4 ? `your bank ending ${prep.bankLast4}` : "your bank";
            lines.push(`Cashed out ${formatUsd(prep.amountUsdsui)} to ${dest}.`);
            break;
          }
          case "request": {
            const amount = p.amountUsd;
            if (!amount || amount <= 0) continue;
            // No signing — just mint a shareable payment link via the existing
            // request rail. Copy it to the clipboard for an easy share.
            const note = step && step.kind === "request" ? step.note : undefined;
            const res = await api<{ payUrl?: string }>(
              "/api/requests",
              { method: "POST", body: { amountUsd: amount, requesterNote: note } }
            );
            const url = res.payUrl ?? "";
            if (url) { try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ } }
            lines.push(url ? `Payment link ready (copied): ${url}` : `Created a payment link for ${formatUsd(amount)}.`);
            break;
          }
          default:
            // swap (and any future kind) isn't executable from chat yet — skip
            // rather than fail the whole plan.
            break;
        }
      }
      setResultLines(lines);
      setStage("done");
      toast("Done", "success");
    } catch (e) {
      setError(friendlyError(e, "Couldn't complete that. Please try again."));
      // Keep the plan visible so the user can tap Accept to retry.
      setStage("plan");
    }
  }

  // Decline — dismiss the proposed plan without touching money.
  function decline() {
    if (stage === "running") return;
    setError(null);
    setStage("declined");
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-[#15300c]/12 bg-white/60 p-4 backdrop-blur-sm">
      {stage === "loading" && (
        <div className="flex items-center gap-2.5">
          <Spinner size={16} />
          <span className="text-[13px] text-[#3a5230]">
            {readOnlyOnly ? "Looking that up…" : "Checking this plan…"}
          </span>
        </div>
      )}

      {stage === "readOnly" && <ResultLines lines={resultLines} muted={false} />}

      {(stage === "plan" || stage === "running" || stage === "failed") && plan && (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-medium text-[#15300c]">{plan.summary}</p>

          {plan.steps.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {plan.steps.map((s, i) => (
                <StepRow key={i} step={s} />
              ))}
            </div>
          )}

          {plan.limit && (
            <p className="font-mono text-[10px] tracking-[0.02em] text-[#3d7a29]">
              {cap(plan.limit.window)} limit {formatUsd(plan.limit.limit)} · used{" "}
              {formatUsd(plan.limit.used)}.
            </p>
          )}

          {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}

          {plan.confirmable && (
            <>
              <div className="flex items-center gap-2.5">
                <PrimaryButton
                  variant="ghost"
                  full
                  onClick={decline}
                  disabled={stage === "running"}
                >
                  Decline
                </PrimaryButton>
                <PrimaryButton
                  full
                  loading={stage === "running"}
                  onClick={confirm}
                >
                  {plan.totalSendUsd > 0 ? `Accept · ${formatUsd(plan.totalSendUsd)}` : "Accept"}
                </PrimaryButton>
              </div>
              <p className="text-center font-mono text-[10px] tracking-[0.02em] text-[#3d7a29]">
                No network fee. Talise sponsors the gas.
              </p>
            </>
          )}
        </div>
      )}

      {stage === "declined" && (
        <p className="text-[13px] text-[#3a5230]">Okay, I didn&apos;t run that. Tell me what to change.</p>
      )}

      {stage === "done" && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={18} color="#3d7a29" strokeWidth={2} />
            <span className="text-[15px] font-semibold text-[#15300c]">Done</span>
          </div>
          <ResultLines lines={resultLines} muted />
        </div>
      )}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

function StepRow({ step }: { step: PlannedStepDTO }) {
  const blocked = step.status === "blocked" || step.status === "needs_info";
  const readOnly = step.status === "read_only";
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0">
        {blocked ? (
          <HugeiconsIcon icon={AlertCircleIcon} size={15} color="#c0532f" strokeWidth={2} />
        ) : readOnly ? (
          <HugeiconsIcon icon={EyeIcon} size={14} color="#3d7a29" strokeWidth={2} />
        ) : (
          <HugeiconsIcon icon={Tick02Icon} size={15} color="#3d7a29" strokeWidth={2.5} />
        )}
      </span>
      <div className="min-w-0">
        <p className={`text-[14px] ${readOnly ? "text-[#3a5230]" : "text-[#15300c]"}`}>
          {step.label}
        </p>
        {step.detail && (
          <p className={`text-[12px] ${blocked ? "text-[#c0532f]" : "text-[#3d7a29]"}`}>
            {step.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function ResultLines({ lines, muted }: { lines: string[]; muted: boolean }) {
  if (lines.length === 0) {
    return <p className="text-[13px] text-[#3a5230]">Nothing to show.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {lines.map((line, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#3d7a29]/60" />
          <span className={`text-[14px] ${muted ? "text-[#3a5230]" : "text-[#15300c]"}`}>
            {line}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Read-only executor (mirrors AgentExecutor.runReadOnly) ──────────────────

async function runReadOnly(
  steps: ChatStep[],
  formatUsd: (usd: number) => string
): Promise<string[]> {
  const lines: string[] = [];
  for (const step of steps) {
    if (!isReadOnlyStep(step)) continue;
    switch (step.kind) {
      case "check_balance": {
        const b = await api<Balances>("/api/balances");
        lines.push(`Available: ${formatUsd(b.usdsui)} · Total ${formatUsd(b.totalUsd)}`);
        break;
      }
      case "check_yield": {
        const cmp = await api<{ venues: Array<{ apy: number; supplied?: number }>; best: { apy: number } | null }>(
          "/api/yield/comparison"
        );
        const supplied = cmp.venues.reduce((sum, v) => sum + (v.supplied ?? 0), 0);
        if (supplied > 0) {
          let s = `Saved ${formatUsd(supplied)} earning`;
          if (cmp.best) s += ` up to ${cmp.best.apy.toFixed(1)}% APY`;
          lines.push(s);
        } else if (cmp.best) {
          lines.push(`Nothing saved yet. Best rate is ${cmp.best.apy.toFixed(1)}% APY.`);
        } else {
          lines.push("Nothing saved yet.");
        }
        break;
      }
      case "show_activity": {
        const n = Math.max(1, Math.min(step.limit ?? 8, 25));
        const r = await api<{ entries: ActivityEntry[] }>("/api/activity", { query: { limit: n } });
        if (r.entries.length === 0) {
          lines.push("No recent activity.");
        } else {
          for (const e of r.entries.slice(0, n)) lines.push(activityLine(e, formatUsd));
        }
        break;
      }
    }
  }
  return lines;
}

function activityLine(e: ActivityEntry, formatUsd: (usd: number) => string): string {
  const amt = formatUsd(Math.abs(e.amountUsdsui ?? 0));
  const who = e.counterpartyName ?? (e.counterparty ? shortAddr(e.counterparty) : "");
  if (e.venue) {
    return e.direction === "received"
      ? `Withdrew ${amt} from ${displayVenue(e.venue)}`
      : `Saved ${amt} into ${displayVenue(e.venue)}`;
  }
  return e.direction === "received"
    ? `Received ${amt}${who ? ` from ${who}` : ""}`
    : `Sent ${amt}${who ? ` to ${who}` : ""}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isReadOnlyStep(s: ChatStep): boolean {
  return s.kind === "check_balance" || s.kind === "check_yield" || s.kind === "show_activity";
}

/** Narrow a step to its `amount` (send/swap/save/withdraw all carry one). */
function stepAmount(s: ChatStep | undefined): number | undefined {
  return s && "amount" in s ? s.amount : undefined;
}

/** Narrow a step to its yield venue (save/withdraw only). */
function stepVenue(s: ChatStep | undefined): YieldVenueId | undefined {
  return s && (s.kind === "save" || s.kind === "withdraw") ? s.venue : undefined;
}

function displayVenue(v: string): string {
  const k = v.toLowerCase();
  if (k === "deepbook") return "DeepBook";
  if (k === "navi") return "NAVI";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function shortAddr(a: string): string {
  return a.startsWith("0x") && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
