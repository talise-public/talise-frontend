"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FlashIcon,
  InformationCircleIcon,
  CheckmarkCircle02Icon,
  Cancel01Icon,
  StopIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
} from "@hugeicons/core-free-icons";
import {
  PrimaryButton,
  SlideToConfirm,
  Spinner,
  EmptyState,
  StatusPill,
  Segmented,
  useSignAndSend,
  useToast,
  resolveRecipient,
  api,
  ApiError,
} from "@/components/app";
import type { StatusTone } from "@/components/app";
import { signSponsorReadyBytes, friendlyError } from "@/components/app/cheques/signBytes";
import { PaySubNav } from "@/components/app/pay/PaySubNav";

// ── Types ─────────────────────────────────────────────────────────────────

type PreparePlan = {
  totalUsd: number;
  totalMicros: string;
  trancheMicros: string;
  trancheUsd: number;
  numTranches: number;
  intervalMs: number;
  startMs: number;
};

type PrepareResp = {
  bytes?: string;
  mode?: "onchain" | "gasless" | "sponsored";
  escrowAddress?: string;
  recipient?: { address: string; displayName: string };
  plan?: PreparePlan;
  error?: string;
};

type ProjectedStream = {
  id: string;
  recipientAddress: string;
  recipientHandle: string | null;
  totalUsd: number;
  releasedUsd: number;
  remainingUsd: number;
  trancheUsd: number;
  numTranches: number;
  tranchesDone: number;
  startMs: number;
  intervalMs: number;
  nextTrancheAt: number | null;
  state: string;
  role: string;
  isSender: boolean;
  isRecipient: boolean;
};

type Tab = "setup" | "list";

const DURATIONS: { label: string; min: number }[] = [
  { label: "1 hour", min: 60 },
  { label: "1 day", min: 1440 },
  { label: "1 week", min: 10080 },
  { label: "30 days", min: 43200 },
];
const INTERVALS: { label: string; min: number }[] = [
  { label: "1 min", min: 1 },
  { label: "10 min", min: 10 },
  { label: "1 hour", min: 60 },
  { label: "1 day", min: 1440 },
];

// ── Page ──────────────────────────────────────────────────────────────────

export default function StreamPage() {
  const [tab, setTab] = useState<Tab>("setup");
  const [listReload, setListReload] = useState(0);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      {/* Keep the Pay sub-nav visible on this sibling route too, without it
          mobile users who tapped into Stream lost the way back to
          Send/Request/Cheques. */}
      <PaySubNav />
      <header className="space-y-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Streaming
        </span>
        <h1
          className="text-[clamp(26px,5vw,32px)] font-[500] tracking-[-0.05em] text-[#15300c]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          Money over time
        </h1>
        <p className="text-[14px] text-[#3a5230]">
          Drip a salary, an allowance, or a payout, fund once, it settles in
          under a second, on schedule.
        </p>
      </header>

      {/* Segmented tab control */}
      <div
        className="flex w-full gap-1 rounded-full border border-[#15300c]/15 bg-white/60 p-1 backdrop-blur-sm"
        role="tablist"
      >
        {([
          { id: "setup" as Tab, label: "New stream" },
          { id: "list" as Tab, label: "Your streams" },
        ]).map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-full px-4 py-2 text-[14px] font-medium transition-colors ${
                active
                  ? "bg-[#CAFFB8] font-semibold text-[#15300c]"
                  : "text-[#3a5230] hover:text-[#15300c]"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "setup" ? (
        <SetupTab
          onStarted={() => {
            setListReload((n) => n + 1);
            setTab("list");
          }}
        />
      ) : (
        <ListTab reloadSignal={listReload} onNew={() => setTab("setup")} />
      )}
    </div>
  );
}

// ── SETUP ───────────────────────────────────────────────────────────────────

function SetupTab({ onStarted }: { onStarted: () => void }) {
  const { send } = useSignAndSend();

  const [query, setQuery] = useState("");
  const [resolved, setResolved] = useState<{ address: string; displayName: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [amount, setAmount] = useState("");
  const [durationMin, setDurationMin] = useState(60);
  const [intervalMin, setIntervalMin] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqSeq = useRef(0);

  const totalUsd = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) ? n : 0;
  }, [amount]);
  const numTranches = useMemo(
    () => Math.max(1, Math.floor(durationMin / Math.max(1, intervalMin))),
    [durationMin, intervalMin]
  );
  const trancheUsd = numTranches > 0 ? totalUsd / numTranches : 0;

  const validSchedule =
    totalUsd > 0 &&
    trancheUsd >= 0.01 &&
    !!resolved &&
    numTranches >= 1 &&
    numTranches <= 5000;

  // Debounced recipient resolve as the user types.
  useEffect(() => {
    setResolved(null);
    setResolveFailed(false);
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    const q = query.trim();
    if (!q) {
      setResolving(false);
      return;
    }
    setResolving(true);
    const seq = ++reqSeq.current;
    resolveTimer.current = setTimeout(async () => {
      try {
        const r = await resolveRecipient(q);
        if (seq !== reqSeq.current) return;
        setResolved(r);
        setResolveFailed(false);
      } catch {
        if (seq !== reqSeq.current) return;
        setResolved(null);
        setResolveFailed(true);
      } finally {
        if (seq === reqSeq.current) setResolving(false);
      }
    }, 400);
    return () => {
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
    };
  }, [query]);

  const statusMessage = useMemo(() => {
    if (!query.trim()) return "Enter a recipient, an @handle or a 0x address.";
    if (resolving) return "Looking up that recipient…";
    if (!resolved) return "Enter a recipient we can find before streaming.";
    if (totalUsd <= 0) return "Enter an amount to stream.";
    if (trancheUsd < 0.01)
      return `Each payment works out to $${trancheUsd.toFixed(4)}, below the $0.01 minimum. Raise the total or stream less often.`;
    if (numTranches > 5000)
      return `That's ${numTranches} payments, too many. Stream less often or over a shorter window.`;
    return "Set a recipient, amount and schedule to start.";
  }, [query, resolving, resolved, totalUsd, trancheUsd, numTranches]);

  const intervalLabel = INTERVALS.find((i) => i.min === intervalMin)?.label ?? `${intervalMin} min`;
  const durationLabel = DURATIONS.find((d) => d.min === durationMin)?.label ?? `${durationMin} min`;

  const start = useCallback(async () => {
    if (!resolved || !validSchedule) return;
    setError(null);
    const intervalMs = intervalMin * 60_000;
    try {
      const prep = await api<PrepareResp>("/api/streams/create-prepare", {
        method: "POST",
        body: { to: resolved.address, totalUsd, intervalMs, numTranches },
      });
      if (prep.error) throw new ApiError(400, prep.error, null);

      // Fund the stream. Streaming is on-chain only now: the server returns
      // sponsor-ready `stream::create<USDSUI>` bytes we sign with the zkLogin
      // ephemeral key. (An escrow fallback is kept only for the unlikely case
      // a deployment hands back a non-onchain mode + escrow address.)
      let fundingDigest: string;
      if (prep.mode === "onchain" && prep.bytes) {
        const { digest } = await signSponsorReadyBytes(prep.bytes, { intent: "start-stream" });
        fundingDigest = digest;
      } else if (prep.escrowAddress) {
        const { digest } = await send({ to: prep.escrowAddress, amountUsd: totalUsd });
        fundingDigest = digest;
      } else {
        throw new ApiError(500, "Couldn't start the stream right now.", null);
      }

      // Record against the SERVER's authoritative plan (amounts + start time)
      // so the stored row matches the on-chain Stream object exactly, never
      // the client's locally-recomputed figures.
      const plan = prep.plan;
      const recordBody = {
        fundingDigest,
        recipientAddress: prep.recipient?.address ?? resolved.address,
        recipientHandle: prep.recipient?.displayName ?? resolved.displayName,
        totalMicros: plan?.totalMicros ?? String(Math.round(totalUsd * 1_000_000)),
        trancheMicros:
          plan?.trancheMicros ??
          String(Math.floor(Math.round(totalUsd * 1_000_000) / numTranches)),
        numTranches: plan?.numTranches ?? numTranches,
        startMs: plan?.startMs ?? Date.now(),
        intervalMs: plan?.intervalMs ?? intervalMs,
      };
      // The funding tx is already on-chain at this point, if the server's
      // read of the digest lags indexing (409 STREAM_OBJECT_UNCONFIRMED),
      // retry the record itself rather than telling the user it failed.
      for (let attempt = 0; ; attempt++) {
        try {
          await api("/api/streams/record", { method: "POST", body: recordBody });
          break;
        } catch (e) {
          const unconfirmed =
            e instanceof ApiError && e.status === 409 && attempt < 2;
          if (!unconfirmed) throw e;
          await new Promise((r) => setTimeout(r, 2500));
        }
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("talise:tx", { detail: { kind: "stream-start" } }));
      }
      onStarted();
    } catch (e) {
      setError(friendlyError(e, "Couldn't start the stream right now.", "Streaming"));
      setResetSignal((n) => n + 1);
      throw e;
    }
  }, [resolved, validSchedule, totalUsd, numTranches, intervalMin, send, onStarted]);

  return (
    <div className="space-y-5">
      {/* Recipient + amount grouped in one card */}
      <div
        className="divide-y divide-[#15300c]/10 overflow-hidden rounded-[28px] bg-[#f7fcf2]"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      >
        {/* Recipient */}
        <div className="px-5 py-4">
          <label className="block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
            To
          </label>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="@handle or 0x address"
              className="w-full bg-transparent text-[15px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
            />
            {resolving ? (
              <Spinner size={16} />
            ) : resolved ? (
              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={18} className="text-[#3d7a29]" />
            ) : resolveFailed ? (
              <HugeiconsIcon icon={Cancel01Icon} size={18} style={{ color: "var(--color-danger)" }} />
            ) : null}
          </div>
          {/* Resolve feedback */}
          <div className="mt-1.5 min-h-[14px] font-mono text-[10px]">
            {resolving ? (
              <span className="text-[#3d7a29]">Looking up recipient…</span>
            ) : resolved ? (
              <span className="text-[#3d7a29]">Resolved: {resolved.displayName}</span>
            ) : resolveFailed ? (
              <span style={{ color: "var(--color-danger)" }}>
                Couldn&apos;t find that recipient. Check the @handle or address.
              </span>
            ) : null}
          </div>
        </div>

        {/* Amount */}
        <div className="px-5 py-4">
          <label className="block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
            Total (USDsui)
          </label>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[22px] text-[#3a5230]" style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>$</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.00"
              className="w-full bg-transparent text-[28px] font-[800] tracking-[-0.05em] text-[#15300c] tabular-nums outline-none placeholder:text-[#3d7a29]"
              style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif' }}
            />
          </div>
        </div>
      </div>

      {/* Schedule */}
      <div
        className="space-y-5 rounded-[28px] bg-[#f7fcf2] p-5"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      >
        <ScheduleSelect label="Over" options={DURATIONS} value={durationMin} onChange={setDurationMin} />
        <ScheduleSelect label="Every" options={INTERVALS} value={intervalMin} onChange={setIntervalMin} />
      </div>

      {/* Live preview / status */}
      {validSchedule ? (
        <div
          className="space-y-1.5 rounded-[28px] bg-[#CAFFB8] p-5"
          style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
        >
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={FlashIcon} size={15} className="text-[#15300c]" />
            <span className="text-[15px] font-semibold text-[#15300c]">
              {numTranches} payments of ${trancheUsd.toFixed(2)}
            </span>
          </div>
          <p className="text-[13px] text-[#15300c]/75">
            One every {intervalLabel}, finishing in {durationLabel}. First payment fires now.
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
            ${totalUsd.toFixed(2)} total · settles in under a second.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-2xl border border-[#15300c]/15 bg-white/60 p-4 backdrop-blur-sm">
          <HugeiconsIcon icon={InformationCircleIcon} size={15} className="mt-0.5 shrink-0 text-[#3d7a29]" />
          <span className="text-[13px] text-[#3a5230]">{statusMessage}</span>
        </div>
      )}

      {error && <InlineError>{error}</InlineError>}

      <SlideToConfirm
        label="Slide to start streaming"
        onConfirm={start}
        disabled={!validSchedule}
        resetSignal={resetSignal}
      />
    </div>
  );
}

// Labelled wrapper around the shared glass <Segmented> control, keeps the
// schedule selectors (duration + interval) consistent with the rest of the
// design system instead of bespoke chip buttons.
function ScheduleSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; min: number }[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
        {label}
      </span>
      <Segmented
        ariaLabel={label}
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o.min, label: o.label }))}
      />
    </div>
  );
}

// ── LIST ─────────────────────────────────────────────────────────────────

function ListTab({ reloadSignal, onNew }: { reloadSignal: number; onNew: () => void }) {
  const { toast } = useToast();
  const [streams, setStreams] = useState<ProjectedStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [pausing, setPausing] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ streams: ProjectedStream[] }>("/api/streams");
      setStreams(r.streams ?? []);
    } catch (e) {
      setError(friendlyError(e, "Couldn't load your streams right now.", "Streaming"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  const cancel = useCallback(
    async (s: ProjectedStream) => {
      setCancelling(s.id);
      setCancelError(null);
      try {
        const r = await api<{
          mode?: string;
          bytes?: string;
          refundUsd?: number;
        }>(`/api/streams/${s.id}/cancel`, { method: "POST", body: {} });
        if (r.mode === "onchain" && r.bytes) {
          await signSponsorReadyBytes(r.bytes, { intent: "cancel-stream" });
        } else if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("talise:tx", { detail: { kind: "stream-cancel" } }));
        }
        await load();
      } catch (e) {
        setCancelError(friendlyError(e, "Couldn't cancel the stream right now.", "Streaming"));
      } finally {
        setCancelling(null);
      }
    },
    [load]
  );

  // Recipient pulls every tranche the on-chain Clock says is due, via the
  // sponsored, permissionless stream::claim_accrued, no scheduler, gas-free.
  const claim = useCallback(
    async (s: ProjectedStream) => {
      setClaiming(s.id);
      setClaimError(null);
      try {
        const r = await api<{
          ok?: boolean;
          mode?: string;
          bytes?: string;
          nothingToClaim?: boolean;
        }>(`/api/streams/${s.id}/claim`, { method: "POST", body: {} });
        if (r.mode === "onchain" && r.bytes) {
          await signSponsorReadyBytes(r.bytes, { intent: "claim-stream" });
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("talise:tx", { detail: { kind: "stream-claim" } }));
          }
        } else if (r.nothingToClaim) {
          setClaimError("Nothing has accrued yet, check back after the next payment.");
        }
        await load();
      } catch (e) {
        setClaimError(friendlyError(e, "Couldn't claim from this stream right now.", "Streaming"));
      } finally {
        setClaiming(null);
      }
    },
    [load]
  );

  // Sender-only pause/resume. Unlike create/claim/cancel these are pure state
  // flips on the DB row (the escrow keeps the funds), the routes return a
  // plain `{ ok, state }` with no sponsor-ready bytes, so there's nothing to
  // sign: just POST, toast, and refresh the projected list.
  const pauseResume = useCallback(
    async (s: ProjectedStream) => {
      const resuming = s.state === "paused";
      setPausing(s.id);
      setPauseError(null);
      try {
        await api<{ ok?: boolean; state?: string }>(
          `/api/streams/${s.id}/${resuming ? "resume" : "pause"}`,
          { method: "POST", body: {} }
        );
        toast(resuming ? "Stream resumed" : "Stream paused", "success");
        await load();
      } catch (e) {
        setPauseError(
          friendlyError(
            e,
            `Couldn't ${resuming ? "resume" : "pause"} the stream right now.`,
            "Streaming"
          )
        );
      } finally {
        setPausing(null);
      }
    },
    [load, toast]
  );

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={26} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <p className="max-w-xs text-[14px] text-[#3a5230]">{error}</p>
        <PrimaryButton variant="ghost" onClick={load}>
          Try again
        </PrimaryButton>
      </div>
    );
  }

  if (streams.length === 0) {
    return (
      <EmptyState
        icon={<HugeiconsIcon icon={RadioIcon} size={26} />}
        title="No streams yet"
        subtitle="Start one to drip money over time, fund once, it settles on schedule."
        action={<PrimaryButton onClick={onNew}>New stream</PrimaryButton>}
      />
    );
  }

  return (
    <div className="space-y-3">
      {cancelError && <InlineError>{cancelError}</InlineError>}
      {claimError && <InlineError>{claimError}</InlineError>}
      {pauseError && <InlineError>{pauseError}</InlineError>}
      {streams.map((s) => {
        const progress = s.totalUsd > 0 ? Math.min(1, s.releasedUsd / s.totalUsd) : 0;
        const canCancel = s.role !== "recipient" && (s.state === "active" || s.state === "paused");
        const canClaim = s.role === "recipient" && s.state === "active" && s.releasedUsd < s.totalUsd;
        // Sender can pause an active stream or resume a paused one, same
        // ownership + non-terminal gate the backend enforces.
        const canPauseResume =
          s.role !== "recipient" && (s.state === "active" || s.state === "paused");
        const isPaused = s.state === "paused";
        return (
          <div
            key={s.id}
            className="space-y-4 rounded-[28px] bg-[#f7fcf2] p-5"
            style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
          >
            {/* Header row */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
                  {s.role === "recipient" ? "Streaming in" : "Streaming out"}
                </span>
                <span className="mt-0.5 block truncate text-[15px] font-medium text-[#15300c]">
                  {s.recipientHandle || shortAddr(s.recipientAddress)}
                </span>
              </div>
              <StatusPill label={s.state} tone={streamTone(s.state)} />
            </div>

            {/* Big number + sublabel */}
            <div>
              <span
                className="block font-[800] tabular-nums text-[#15300c]"
                style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontSize: 26, letterSpacing: "-0.02em", lineHeight: 1 }}
              >
                ${s.releasedUsd.toFixed(2)}
              </span>
              <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-[#3d7a29]">
                of ${s.totalUsd.toFixed(2)} · {s.tranchesDone}/{s.numTranches} payments
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#15300c]/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${progress * 100}%`,
                  background: "#3d7a29",
                  transition: "width 400ms ease-out",
                }}
              />
            </div>

            {canClaim && (
              <PrimaryButton
                full
                loading={claiming === s.id}
                disabled={claiming != null && claiming !== s.id}
                onClick={() => claim(s)}
              >
                {claiming === s.id ? "Claiming…" : "Claim available"}
              </PrimaryButton>
            )}

            {canPauseResume && (
              <PrimaryButton
                variant="ghost"
                full
                loading={pausing === s.id}
                disabled={pausing != null && pausing !== s.id}
                onClick={() => pauseResume(s)}
              >
                {pausing !== s.id && (
                  <HugeiconsIcon icon={isPaused ? PlayIcon : PauseIcon} size={15} />
                )}
                {pausing === s.id
                  ? isPaused
                    ? "Resuming…"
                    : "Pausing…"
                  : isPaused
                    ? "Resume stream"
                    : "Pause stream"}
              </PrimaryButton>
            )}

            {canCancel && (
              <PrimaryButton
                variant="ghost"
                full
                loading={cancelling === s.id}
                disabled={cancelling != null && cancelling !== s.id}
                onClick={() => cancel(s)}
              >
                {cancelling !== s.id && <HugeiconsIcon icon={StopIcon} size={15} />}
                {cancelling === s.id ? "Cancelling…" : "Cancel & refund remainder"}
              </PrimaryButton>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl px-4 py-3 text-[13px]"
      style={{
        background: "color-mix(in srgb, var(--color-danger) 12%, transparent)",
        color: "var(--color-danger)",
      }}
    >
      <HugeiconsIcon icon={Cancel01Icon} size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function streamTone(state: string): StatusTone {
  switch (state) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "cancelled":
      return "neutral";
    default:
      return "neutral";
  }
}

function shortAddr(a: string): string {
  if (!a || a.length <= 12) return a || "-";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
