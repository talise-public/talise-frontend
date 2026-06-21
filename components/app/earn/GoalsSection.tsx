"use client";

/**
 * Savings goals. A grid of goal cards (each with a progress ring), a new-goal
 * sheet, and a deposit sheet. Reads GET /api/rewards/goals; creates via POST
 * /api/rewards/goals; deposits via POST /api/rewards/goals/[id] { amountUsd }.
 *
 * A tracking deposit records the goal contribution server-side (and awards
 * points) — it doesn't move on-chain funds, so it doesn't need the signer.
 */

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Target02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  GlassCard,
  Eyebrow,
  Sheet,
  Field,
  PrimaryButton,
  EmptyState,
  api,
  useCurrency,
  useToast,
  ApiError,
} from "@/components/app";
import { useGoals, type Goal } from "./earn-data";

// Decorative ring/swatch palette. These are FILL colours (progress-ring
// strokes), so they must read against the white goal card — the leading swatch
// is the Talise forest, not the pale mint (#caffb8 is invisible on white).
const GOAL_COLORS = ["#3d7a29", "#3a93d6", "#d99a2a", "#9a5cd6", "#d6618f", "#2faf8a"];

export function GoalsSection() {
  const { goals, loading, refresh } = useGoals();
  const { formatUsd } = useCurrency();

  const [creating, setCreating] = useState(false);
  const [depositTarget, setDepositTarget] = useState<Goal | null>(null);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <Eyebrow>Goals</Eyebrow>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-[#3d7a29]"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2.2} />
          New goal
        </button>
      </div>

      {loading && goals.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <GoalSkeleton />
          <GoalSkeleton />
        </div>
      ) : goals.length === 0 ? (
        <GlassCard radius={28} className="px-2 py-4">
          <EmptyState
            icon={<HugeiconsIcon icon={Target02Icon} size={24} strokeWidth={1.6} />}
            title="No goals yet"
            subtitle="Set a target — a trip, a rainy-day fund — and track every contribution."
            action={
              <PrimaryButton onClick={() => setCreating(true)}>Create a goal</PrimaryButton>
            }
          />
        </GlassCard>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {goals.map((g, i) => (
            <GoalCard
              key={g.id}
              goal={g}
              color={g.color ?? GOAL_COLORS[i % GOAL_COLORS.length]}
              formatUsd={formatUsd}
              onDeposit={() => setDepositTarget(g)}
            />
          ))}
        </div>
      )}

      <NewGoalSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void refresh();
        }}
      />

      <DepositSheet
        goal={depositTarget}
        onClose={() => setDepositTarget(null)}
        onDeposited={() => {
          setDepositTarget(null);
          void refresh();
        }}
      />
    </section>
  );
}

function GoalCard({
  goal,
  color,
  formatUsd,
  onDeposit,
}: {
  goal: Goal;
  color: string;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  onDeposit: () => void;
}) {
  const pct = goal.targetUsd > 0 ? Math.min(1, goal.currentUsd / goal.targetUsd) : 0;
  const complete = pct >= 1;
  return (
    <GlassCard radius={24} className="p-4">
      <div className="flex items-center gap-3">
        <ProgressRing pct={pct} color={color} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[#15300c]">
            {goal.name}
          </p>
          <p className="truncate font-mono text-[11px] text-[#3d7a29]">
            {formatUsd(goal.currentUsd, { fixed: true })} of{" "}
            {formatUsd(goal.targetUsd, { fixed: true })}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <PrimaryButton full variant="ghost" onClick={onDeposit}>
          {complete ? "Add more" : "Add to goal"}
        </PrimaryButton>
      </div>
    </GlassCard>
  );
}

function ProgressRing({ pct, color }: { pct: number; color: string }) {
  const size = 48;
  const stroke = 4.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * pct;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(21,48,12,0.12)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="rotate-90 fill-[#15300c] font-mono text-[10px] font-medium"
        style={{ transformOrigin: "center" }}
      >
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

function GoalSkeleton() {
  return (
    <GlassCard radius={24} className="flex items-center gap-3 p-4 opacity-70">
      <div className="size-12 shrink-0 rounded-full bg-[#15300c]/10" />
      <div className="flex-1 space-y-2">
        <div className="h-2.5 w-24 rounded-full bg-[#15300c]/10" />
        <div className="h-2 w-32 rounded-full bg-[#15300c]/10" />
      </div>
    </GlassCard>
  );
}

function NewGoalSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { symbol, rate, currency } = useCurrency();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [color, setColor] = useState(GOAL_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetUsd = useMemo(() => {
    const local = Number(target);
    return Number.isFinite(local) && local > 0 ? local / (rate || 1) : 0;
  }, [target, rate]);

  async function create() {
    if (!name.trim() || targetUsd <= 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/rewards/goals", {
        method: "POST",
        body: { name: name.trim(), targetUsd, color },
      });
      toast("Goal created", "success");
      setName("");
      setTarget("");
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't create goal. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New goal" size="md">
      <div className="space-y-4 pb-1">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Japan trip"
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-[14px] text-[#15300c] outline-none backdrop-blur-sm transition-colors placeholder:text-[#3d7a29] focus:border-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/30"
          />
        </Field>

        <Field label={`Target (${currency})`}>
          <div className="flex items-center gap-2 rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 backdrop-blur-sm">
            <span className="text-[17px] font-medium text-[#3a5230]">{symbol}</span>
            <input
              inputMode="decimal"
              value={target}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "");
                if ((v.match(/\./g) ?? []).length <= 1) setTarget(v);
              }}
              placeholder="0.00"
              className="w-full bg-transparent text-[17px] font-medium tabular-nums text-[#15300c] outline-none placeholder:text-[#3d7a29]"
            />
          </div>
        </Field>

        <div>
          <Eyebrow className="mb-2 block">Colour</Eyebrow>
          <div className="flex gap-2.5">
            {GOAL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Colour ${c}`}
                className="size-7 rounded-full transition-transform active:scale-90"
                style={{
                  background: c,
                  outline: color === c ? "2px solid #15300c" : "none",
                  outlineOffset: 2,
                }}
              />
            ))}
          </div>
        </div>

        {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}

        <PrimaryButton
          full
          disabled={!name.trim() || targetUsd <= 0}
          loading={busy}
          onClick={create}
        >
          Create goal
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

function DepositSheet({
  goal,
  onClose,
  onDeposited,
}: {
  goal: Goal | null;
  onClose: () => void;
  onDeposited: () => void;
}) {
  const { symbol, rate, currency, formatUsd } = useCurrency();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountUsd = useMemo(() => {
    const local = Number(amount);
    return Number.isFinite(local) && local > 0 ? local / (rate || 1) : 0;
  }, [amount, rate]);

  async function deposit() {
    if (!goal || amountUsd <= 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ pointsAwarded?: number }>(`/api/rewards/goals/${goal.id}`, {
        method: "POST",
        body: { amountUsd },
      });
      const pts = res.pointsAwarded ?? 0;
      toast(pts > 0 ? `Added · +${pts} pts` : "Added to goal", "success");
      setAmount("");
      onDeposited();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add to goal. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const remaining = goal ? Math.max(0, goal.targetUsd - goal.currentUsd) : 0;

  return (
    <Sheet open={!!goal} onClose={onClose} title={goal ? goal.name : "Add"} size="sm">
      {goal && (
        <div className="space-y-4 pb-1">
          <p className="text-[13px] text-[#3a5230]">
            {remaining > 0
              ? `${formatUsd(remaining, { fixed: true })} to go.`
              : "Goal reached — keep adding if you like."}
          </p>
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
          {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}
          <PrimaryButton full disabled={amountUsd <= 0} loading={busy} onClick={deposit}>
            {amountUsd > 0 ? `Add ${formatUsd(amountUsd, { fixed: true })}` : "Add to goal"}
          </PrimaryButton>
        </div>
      )}
    </Sheet>
  );
}
