"use client";

/**
 * Goal action sheet. Opened by tapping a goal card, it surfaces the goal's
 * progress plus every per-goal action the iOS app offers:
 *
 *   - Add money  → POST /api/rewards/goals/[id] { amountUsd, action:"deposit" }
 *   - Withdraw   → POST /api/rewards/goals/[id] { amountUsd, action:"withdraw" }
 *   - Archive    → PATCH /api/rewards/goals/[id] { archive:true }
 *
 * Add/Withdraw share one amount field, toggled by a <Segmented>. Like the rest
 * of the rewards-goals model these are TRACKING writes, the dollars stay
 * liquid in the user's own yield-earning balance, so no signer is needed.
 */

import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Archive01Icon, Calendar03Icon } from "@hugeicons/core-free-icons";
import {
  Sheet,
  Field,
  PrimaryButton,
  Segmented,
  OptionRow,
  Eyebrow,
  api,
  useCurrency,
  useToast,
  ApiError,
} from "@/components/app";
import type { Goal } from "./earn-data";

type Mode = "add" | "withdraw";

/** Whole-day countdown to a deadline; null once it's in the past / unset. */
function daysLeft(deadlineMs: number | null): number | null {
  if (!deadlineMs) return null;
  const ms = deadlineMs - Date.now();
  if (ms <= 0) return null;
  return Math.ceil(ms / 86_400_000);
}

export function GoalActionSheet({
  goal,
  onClose,
  onChanged,
}: {
  goal: Goal | null;
  onClose: () => void;
  /** Called after any successful mutation so the parent can refresh the list. */
  onChanged: () => void;
}) {
  const { symbol, rate, currency, formatUsd } = useCurrency();
  const { toast } = useToast();

  const [mode, setMode] = useState<Mode>("add");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  // Reset the local form whenever a different goal is opened (the Sheet stays
  // mounted across opens, so state would otherwise leak between goals).
  useEffect(() => {
    setMode("add");
    setAmount("");
    setError(null);
    setBusy(false);
    setConfirmingArchive(false);
  }, [goal?.id]);

  const amountUsd = useMemo(() => {
    const local = Number(amount);
    return Number.isFinite(local) && local > 0 ? local / (rate || 1) : 0;
  }, [amount, rate]);

  const pct = goal && goal.targetUsd > 0 ? Math.min(1, goal.currentUsd / goal.targetUsd) : 0;
  const remaining = goal ? Math.max(0, goal.targetUsd - goal.currentUsd) : 0;
  const left = daysLeft(goal?.deadlineMs ?? null);

  // Withdrawals can never exceed what's been set aside (a tiny epsilon absorbs
  // float drift from the local↔USD conversion).
  const overWithdraw = !!goal && mode === "withdraw" && amountUsd > goal.currentUsd + 1e-6;
  const submitDisabled = amountUsd <= 0 || overWithdraw;

  async function submit() {
    if (!goal || submitDisabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "withdraw") {
        const res = await api<{ withdrawnUsd?: number }>(`/api/rewards/goals/${goal.id}`, {
          method: "POST",
          body: { amountUsd, action: "withdraw" },
        });
        toast(`Withdrew ${formatUsd(res.withdrawnUsd ?? amountUsd, { fixed: true })}`, "success");
      } else {
        const res = await api<{ pointsAwarded?: number }>(`/api/rewards/goals/${goal.id}`, {
          method: "POST",
          body: { amountUsd, action: "deposit" },
        });
        const pts = res.pointsAwarded ?? 0;
        toast(pts > 0 ? `Added · +${pts} pts` : "Added to goal", "success");
      }
      setAmount("");
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : mode === "withdraw"
            ? "Couldn't withdraw. Try again."
            : "Couldn't add to goal. Try again."
      );
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/rewards/goals/${goal.id}`, {
        method: "PATCH",
        body: { archive: true },
      });
      toast("Goal archived", "success");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't archive goal. Try again.");
      setBusy(false);
    }
    // On success the parent closes the sheet (goal → null); no need to clear busy.
  }

  return (
    <Sheet open={!!goal} onClose={onClose} title={goal ? goal.name : "Goal"} size="sm">
      {goal && (
        <div className="space-y-4 pb-1">
          {/* Progress header */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-mono text-[12px] text-[#3d7a29]">
                {formatUsd(goal.currentUsd, { fixed: true })} of{" "}
                {formatUsd(goal.targetUsd, { fixed: true })}
              </p>
              <p className="font-mono text-[12px] font-medium text-[#15300c]">
                {Math.round(pct * 100)}%
              </p>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[#15300c]/10">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${pct * 100}%`, background: goal.color ?? "#3d7a29" }}
              />
            </div>
            <div className="flex items-center justify-between gap-2 text-[12px] text-[#3a5230]">
              <span>
                {remaining > 0
                  ? `${formatUsd(remaining, { fixed: true })} to go`
                  : "Goal reached"}
              </span>
              {left !== null && (
                <span className="inline-flex items-center gap-1 text-[#3d7a29]">
                  <HugeiconsIcon icon={Calendar03Icon} size={13} strokeWidth={1.8} />
                  {left} day{left === 1 ? "" : "s"} left
                </span>
              )}
            </div>
          </div>

          {/* Add / Withdraw */}
          <Segmented<Mode>
            ariaLabel="Choose action"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { value: "add", label: "Add money" },
              { value: "withdraw", label: "Withdraw" },
            ]}
          />

          <Field label={`Amount (${currency})`}>
            <div className="flex items-center gap-2 rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 backdrop-blur-sm">
              <span className="text-[20px] font-medium text-[#3a5230]">{symbol}</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, "");
                  if ((v.match(/\./g) ?? []).length <= 1) setAmount(v);
                  setError(null);
                }}
                placeholder="0.00"
                className="w-full bg-transparent text-[20px] font-medium tabular-nums text-[#15300c] outline-none placeholder:text-[#3d7a29]"
              />
            </div>
          </Field>

          {overWithdraw && (
            <p className="text-[13px] text-[#c0532f]">
              You can withdraw at most {formatUsd(goal.currentUsd, { fixed: true })}.
            </p>
          )}
          {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}

          <PrimaryButton
            full
            variant={mode === "withdraw" ? "ghost" : "primary"}
            disabled={submitDisabled}
            loading={busy && !confirmingArchive}
            onClick={submit}
          >
            {mode === "withdraw"
              ? amountUsd > 0
                ? `Withdraw ${formatUsd(amountUsd, { fixed: true })}`
                : "Withdraw"
              : amountUsd > 0
                ? `Add ${formatUsd(amountUsd, { fixed: true })}`
                : "Add to goal"}
          </PrimaryButton>

          {/* Archive */}
          <div className="border-t border-[#15300c]/10 pt-3">
            {confirmingArchive ? (
              <div className="space-y-3">
                <Eyebrow className="block">Archive goal</Eyebrow>
                <p className="text-[13px] text-[#3a5230]">
                  This hides “{goal.name}” from your active goals. Your tracked balance
                  isn&apos;t touched.
                </p>
                <div className="flex gap-2">
                  <PrimaryButton
                    full
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmingArchive(false)}
                  >
                    Cancel
                  </PrimaryButton>
                  <PrimaryButton full variant="danger" loading={busy} onClick={archive}>
                    Archive
                  </PrimaryButton>
                </div>
              </div>
            ) : (
              <OptionRow
                icon={<HugeiconsIcon icon={Archive01Icon} size={18} strokeWidth={1.8} />}
                title="Archive goal"
                subtitle="Hide it from your active goals"
                onClick={() => {
                  setConfirmingArchive(true);
                  setError(null);
                }}
              />
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
