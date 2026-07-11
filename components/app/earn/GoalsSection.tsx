"use client";

/**
 * Savings goals. A grid of goal cards (each with a progress ring) plus a
 * new-goal sheet. Tapping a card opens the GoalActionSheet (add / withdraw /
 * archive). Reads GET /api/rewards/goals; creates via POST /api/rewards/goals
 * (name, target, colour, optional deadline).
 *
 * A tracking deposit records the goal contribution server-side (and awards
 * points) — it doesn't move on-chain funds, so it doesn't need the signer.
 */

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Target02Icon, PlusSignIcon, Calendar03Icon } from "@hugeicons/core-free-icons";
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
import { GoalActionSheet } from "./GoalActionSheet";

// Decorative ring/swatch palette. These are FILL colours (progress-ring
// strokes), so they must read against the white goal card — the leading swatch
// is the Talise forest, not the pale mint (#caffb8 is invisible on white).
const GOAL_COLORS = ["#3d7a29", "#3a93d6", "#d99a2a", "#9a5cd6", "#d6618f", "#2faf8a"];

export function GoalsSection() {
  const { goals, loading, refresh } = useGoals();
  const { formatUsd } = useCurrency();

  const [creating, setCreating] = useState(false);
  const [actionTarget, setActionTarget] = useState<Goal | null>(null);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <Eyebrow>Goals</Eyebrow>
        {/* Styled glass CTA — a compact ghost pill matching the design system,
            replacing the old bare mono-text button. */}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 text-[12px] font-semibold text-[#15300c] backdrop-blur-sm outline-none transition-[transform,background-color] duration-150 hover:bg-[#CAFFB8] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2.2} />
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
              onOpen={() => setActionTarget(g)}
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

      <GoalActionSheet
        goal={actionTarget}
        onClose={() => setActionTarget(null)}
        onChanged={() => {
          // Pull the fresh figure, then close so the card reflects the change
          // (an archived goal drops off the active grid entirely).
          void refresh();
          setActionTarget(null);
        }}
      />
    </section>
  );
}

/** Whole-day countdown to a deadline; null once it's in the past / unset. */
function daysLeft(deadlineMs: number | null): number | null {
  if (!deadlineMs) return null;
  const ms = deadlineMs - Date.now();
  if (ms <= 0) return null;
  return Math.ceil(ms / 86_400_000);
}

function GoalCard({
  goal,
  color,
  formatUsd,
  onOpen,
}: {
  goal: Goal;
  color: string;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  /** Open the action sheet (add / withdraw / archive). */
  onOpen: () => void;
}) {
  const pct = goal.targetUsd > 0 ? Math.min(1, goal.currentUsd / goal.targetUsd) : 0;
  const left = daysLeft(goal.deadlineMs);
  // The whole card is the tap target (opens the action sheet). GlassCard stays
  // a <div> with the hover-lift affordance; the inner <button> carries the
  // click + keyboard focus, with phrasing-only content (spans, not <p>/<div>)
  // since block elements aren't valid button descendants.
  return (
    <GlassCard radius={24} className="!p-0" interactive>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-[24px] p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45"
      >
        <ProgressRing pct={pct} color={color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold tracking-[-0.01em] text-[#15300c]">
            {goal.name}
          </span>
          <span className="block truncate font-mono text-[11px] text-[#3d7a29]">
            {formatUsd(goal.currentUsd, { fixed: true })} of{" "}
            {formatUsd(goal.targetUsd, { fixed: true })}
          </span>
          {left !== null && (
            <span className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-[#3a5230]">
              <HugeiconsIcon icon={Calendar03Icon} size={12} strokeWidth={1.8} />
              {left} day{left === 1 ? "" : "s"} left
            </span>
          )}
        </span>
      </button>
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
  // Optional target date (yyyy-mm-dd from the native picker → epoch ms).
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetUsd = useMemo(() => {
    const local = Number(target);
    return Number.isFinite(local) && local > 0 ? local / (rate || 1) : 0;
  }, [target, rate]);

  // Today (local) as the min for the date picker — a deadline in the past is
  // meaningless. The route already accepts/stores deadlineMs.
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  async function create() {
    if (!name.trim() || targetUsd <= 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const deadlineMs = deadline ? new Date(`${deadline}T00:00:00`).getTime() : null;
      await api("/api/rewards/goals", {
        method: "POST",
        body: {
          name: name.trim(),
          targetUsd,
          color,
          ...(deadlineMs && Number.isFinite(deadlineMs) ? { deadlineMs } : {}),
        },
      });
      toast("Goal created", "success");
      setName("");
      setTarget("");
      setDeadline("");
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

        <Field label="Target date (optional)">
          <input
            type="date"
            value={deadline}
            min={todayIso}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-[14px] text-[#15300c] outline-none backdrop-blur-sm transition-colors placeholder:text-[#3d7a29] focus:border-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/30"
          />
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
