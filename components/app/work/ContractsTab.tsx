"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  UserGroupIcon,
  PlusSignIcon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import {
  triggerOauthSignIn,
  readEphemeralForT2000,
} from "@/lib/zkclient";
import {
  GlassCard,
  PrimaryButton,
  StatusPill,
  Sheet,
  Field,
  Segmented,
  Eyebrow,
  MicroLabel,
  EmptyState,
  Spinner,
  SlideToConfirm,
  api,
  ApiError,
  useToast,
  useCurrency,
  resolveRecipient,
} from "@/components/app";
import { signSponsorReadyBytes, friendlyError } from "@/components/app/cheques/signBytes";

type Cadence = "hourly" | "daily" | "weekly" | "monthly";

const CADENCES: { id: Cadence; label: string; period: string; ms: number }[] = [
  { id: "hourly", label: "Hourly", period: "hour", ms: 3_600_000 },
  { id: "daily", label: "Daily", period: "day", ms: 86_400_000 },
  { id: "weekly", label: "Weekly", period: "week", ms: 604_800_000 },
  { id: "monthly", label: "Monthly", period: "month", ms: 2_592_000_000 },
];

type Contract = {
  id: string;
  payeeAddress: string;
  payeeHandle: string | null;
  title: string;
  rateUsd: number;
  cadence: Cadence;
  cadenceLabel: string;
  periods: number;
  totalUsd: number;
  streamId: string;
  status: "active" | "completed" | "cancelled";
  paidUsd: number;
  remainingUsd: number;
  periodsPaid: number;
  nextPayAt: number | null;
  streamState: string | null;
};

export function ContractsTab() {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelFor, setCancelFor] = useState<Contract | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ contracts: Contract[] }>("/api/contracts");
      setContracts(r.contracts ?? []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Cancel a contract: the server flips status + returns Onara-SPONSORED on-chain
  // `cancel_and_withdraw` bytes (mode:'onchain') that the SENDER must sign to pull
  // the unsent remainder back. Streaming is on-chain only — there's no gasless
  // refund path, so we sign the returned bytes when present.
  const cancel = useCallback(
    async (c: Contract) => {
      setCancelling(true);
      try {
        const r = await api<{
          status: string;
          mode?: string;
          bytes?: string;
          refundUsd?: number;
          refunded?: boolean;
          detail?: string;
        }>(`/api/contracts/${c.id}`, {
          method: "POST",
          body: { action: "cancel" },
        });

        // On-chain refund: sign + broadcast the withdraw bytes the server built.
        if (r.mode === "onchain" && r.bytes) {
          try {
            await signSponsorReadyBytes(r.bytes, { kind: "stream-cancel" });
            toast(
              r.refundUsd
                ? `Contract cancelled — ${formatUsd(r.refundUsd, { fixed: true })} returned`
                : "Contract cancelled",
              "neutral"
            );
          } catch (signErr) {
            // The contract is already cancelled server-side; only the on-chain
            // withdraw didn't complete. Funds stay safe in the Stream object.
            if (signErr instanceof ApiError && signErr.code === "NOT_SIGNED_IN") {
              toast("Sign in to claim the unsent balance.", "danger");
            } else {
              toast(
                "Contract cancelled, but the refund withdraw didn't go through. Try again.",
                "danger"
              );
            }
          }
        } else {
          toast(
            r.refunded && r.refundUsd
              ? `Contract cancelled — ${formatUsd(r.refundUsd, { fixed: true })} returned`
              : "Contract cancelled",
            "neutral"
          );
        }
        setCancelFor(null);
        await load();
      } catch (err) {
        toast(
          err instanceof ApiError ? friendlyError(err, "Couldn't cancel") : "Couldn't cancel",
          "danger"
        );
      } finally {
        setCancelling(false);
      }
    },
    [toast, formatUsd, load]
  );

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <Eyebrow>Active contracts</Eyebrow>
        <PrimaryButton onClick={() => setCreateOpen(true)} variant="ghost">
          <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
          New contract
        </PrimaryButton>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={22} />
        </div>
      ) : contracts.length === 0 ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={<HugeiconsIcon icon={UserGroupIcon} size={26} strokeWidth={1.6} />}
            title="No contracts yet"
            subtitle="Set up recurring pay for a contractor or teammate. Fund it once — Talise releases each pay period automatically."
            action={
              <PrimaryButton onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
                Hire someone
              </PrimaryButton>
            }
          />
        </GlassCard>
      ) : (
        /* Wise-style: all contracts in one flat card as stacked rows */
        <GlassCard className="overflow-hidden p-0">
          {contracts.map((c, i) => (
            <ContractRow
              key={c.id}
              c={c}
              formatUsd={formatUsd}
              onCancel={() => setCancelFor(c)}
              divider={i < contracts.length - 1}
            />
          ))}
        </GlassCard>
      )}

      <CreateContractSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void load();
        }}
      />

      {/* Cancel confirmation */}
      <Sheet
        open={!!cancelFor}
        onClose={() => {
          if (!cancelling) setCancelFor(null);
        }}
        title="Cancel contract"
      >
        <div className="space-y-4">
          <p className="text-[14px] text-[#3a5230]">
            {cancelFor ? (
              <>
                Cancel <span className="font-medium text-[#15300c]">{cancelFor.title}</span>? Future
                pay stops and the unsent{" "}
                <span className="font-medium text-[#15300c]">
                  {formatUsd(cancelFor.remainingUsd, { fixed: true })}
                </span>{" "}
                is returned to you. You&apos;ll sign once to release the refund.
              </>
            ) : null}
          </p>
          <div className="flex items-center gap-2">
            <PrimaryButton
              onClick={() => setCancelFor(null)}
              variant="ghost"
              disabled={cancelling}
              full
            >
              Keep it
            </PrimaryButton>
            <PrimaryButton
              onClick={() => cancelFor && cancel(cancelFor)}
              variant="danger"
              loading={cancelling}
              full
            >
              Cancel contract
            </PrimaryButton>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

// ── Contract row (Wise list-row pattern) ───────────────────────────────────

function ContractRow({
  c,
  formatUsd,
  onCancel,
  divider,
}: {
  c: Contract;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  onCancel: () => void;
  divider: boolean;
}) {
  const pct = c.totalUsd > 0 ? Math.min(100, (c.paidUsd / c.totalUsd) * 100) : 0;
  const stateTone =
    c.status === "cancelled"
      ? "danger"
      : c.status === "completed" || c.streamState === "completed"
        ? "completed"
        : c.streamState === "paused"
          ? "paused"
          : "active";
  const stateLabel =
    c.status === "cancelled"
      ? "Cancelled"
      : c.streamState === "completed" || c.status === "completed"
        ? "Completed"
        : c.streamState === "paused"
          ? "Paused"
          : "Active";

  const next =
    c.nextPayAt && c.status === "active" && c.streamState === "active"
      ? new Date(c.nextPayAt)
      : null;
  const payee = c.payeeHandle || `${c.payeeAddress.slice(0, 6)}…${c.payeeAddress.slice(-4)}`;

  return (
    <div>
      <div className="flex items-start gap-3.5 px-4 py-3.5 transition-colors hover:bg-[#15300c]/[0.04]">
        {/* Circular icon chip */}
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={UserGroupIcon} size={17} strokeWidth={1.8} />
        </span>

        {/* Title + payee + progress */}
        <span className="min-w-0 flex-1 space-y-2">
          <span>
            <span className="block truncate text-[15px] font-medium text-[#15300c]">{c.title}</span>
            <span className="block truncate font-mono text-[11px] text-[#3d7a29]">
              {payee} · {formatUsd(c.rateUsd, { fixed: true })}/{c.cadenceLabel}
            </span>
          </span>

          {/* Progress bar */}
          <span className="block">
            <span className="block h-1.5 w-full overflow-hidden rounded-full bg-[#15300c]/10">
              <span
                className="block h-full rounded-full bg-[#3d7a29] transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="mt-1 flex items-center justify-between">
              <span className="font-mono text-[11px] text-[#3d7a29]" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatUsd(c.paidUsd, { fixed: true })} / {formatUsd(c.totalUsd, { fixed: true })}
              </span>
              <span className="font-mono text-[10px] text-[#3d7a29]">
                {c.periodsPaid}/{c.periods}
              </span>
            </span>
          </span>
        </span>

        {/* Status + next pay + action */}
        <span className="flex shrink-0 flex-col items-end gap-2">
          <StatusPill label={stateLabel} tone={stateTone} />
          {next ? (
            <span className="font-mono text-[11px] text-[#3d7a29]">
              Next {next.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-[#3d7a29]">
              {formatUsd(c.remainingUsd, { fixed: true })} left
            </span>
          )}
          {c.status === "active" && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-[#3d7a29] transition-colors hover:bg-[#15300c]/10 hover:text-[#c0532f]"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              Cancel
            </button>
          )}
        </span>
      </div>

      {divider && <div className="mx-4 border-t border-[#15300c]/10" />}
    </div>
  );
}

// ── Create contract sheet ──────────────────────────────────────────────────

type Resolved = { address: string; displayName: string };

function CreateContractSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();

  const [payeeInput, setPayeeInput] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [rate, setRate] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [periods, setPeriods] = useState("4");

  const [slideReset, setSlideReset] = useState(0);

  const cad = CADENCES.find((c) => c.id === cadence)!;
  const rateNum = Number(rate);
  const periodsNum = Math.floor(Number(periods));
  const total =
    Number.isFinite(rateNum) && rateNum > 0 && periodsNum > 0
      ? Math.round(rateNum * periodsNum * 100) / 100
      : 0;

  const reset = () => {
    setPayeeInput("");
    setResolved(null);
    setResolveErr(null);
    setTitle("");
    setRate("");
    setCadence("weekly");
    setPeriods("4");
  };

  // Debounced recipient resolve.
  useEffect(() => {
    const q = payeeInput.trim();
    setResolved(null);
    setResolveErr(null);
    if (q.length < 2) return;
    let cancelled = false;
    setResolving(true);
    const t = setTimeout(async () => {
      try {
        const r = await resolveRecipient(q);
        if (!cancelled) setResolved(r);
      } catch (err) {
        if (!cancelled) {
          setResolveErr(
            err instanceof ApiError && err.status === 404
              ? "No Talise user found for that handle or address."
              : "Couldn't resolve that recipient."
          );
        }
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [payeeInput]);

  const previewName = resolved?.displayName || payeeInput.trim() || "your payee";

  const ready = !!resolved && !!title.trim() && total > 0 && periodsNum > 0;

  // The full hire-&-fund pipeline: fund the stream (sponsor-prepare → sign →
  // execute → record), then persist the contract metadata.
  const hireAndFund = useCallback(async () => {
    if (!resolved) {
      toast("Pick a valid recipient first", "danger");
      throw new Error("no recipient");
    }

    // Bail to sign-in early if there's no ephemeral key in this tab (so we don't
    // burn a prepare/build before kicking the OAuth flow).
    if (!readEphemeralForT2000()) {
      triggerOauthSignIn({
        returnTo: typeof location !== "undefined" ? location.pathname : "/app/work",
      });
      throw new Error("not signed in");
    }

    // 1) Prepare the stream funding tx. Streaming is ON-CHAIN only now: this
    //    returns mode:'onchain' Onara-sponsored `stream::create<USDSUI>` bytes
    //    that the sender signs (no gasless rail for a custom Move call).
    const prep = await api<{
      bytes: string;
      mode: string;
      recipient?: { address: string; displayName: string };
      plan: {
        totalMicros: string;
        trancheMicros: string;
        numTranches: number;
        intervalMs: number;
        startMs: number;
      };
    }>("/api/streams/create-prepare", {
      method: "POST",
      body: {
        to: resolved.address,
        totalUsd: total,
        intervalMs: cad.ms,
        numTranches: periodsNum,
      },
    });

    // 2) Sign the sponsor-ready bytes with the zkLogin ephemeral key and
    //    broadcast via /api/zk/sponsor-execute → confirmed funding digest.
    const { digest: fundingDigest } = await signSponsorReadyBytes(prep.bytes, {
      kind: "stream-fund",
    });

    // 3) Record the stream — the server parses the created on-chain Stream
    //    object id from the funding digest and returns it as the stream id.
    //    The funding tx is already on-chain here; if the server's read lags
    //    indexing (409 STREAM_OBJECT_UNCONFIRMED), retry rather than fail.
    let rec: { id: string };
    for (let attempt = 0; ; attempt++) {
      try {
        rec = await api<{ id: string }>("/api/streams/record", {
          method: "POST",
          body: {
            fundingDigest,
            recipientAddress: resolved.address,
            recipientHandle: resolved.displayName || null,
            totalMicros: prep.plan.totalMicros,
            trancheMicros: prep.plan.trancheMicros,
            numTranches: prep.plan.numTranches,
            startMs: prep.plan.startMs,
            intervalMs: prep.plan.intervalMs,
          },
        });
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409 && attempt < 2)) throw e;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }

    // 4) Persist the contract metadata wrapping that stream.
    await api("/api/contracts", {
      method: "POST",
      body: {
        payeeAddress: resolved.address,
        payeeHandle: resolved.displayName || null,
        title: title.trim(),
        rateUsd: rateNum,
        cadence,
        periods: periodsNum,
        streamId: rec.id,
        fundingDigest,
      },
    });

    toast("Contract funded — pay starts now", "success");
    reset();
    onCreated();
  }, [resolved, total, cad.ms, periodsNum, title, rateNum, cadence, toast, onCreated]);

  const onConfirm = useCallback(async () => {
    try {
      await hireAndFund();
    } catch (err) {
      // Reset the slider so the user can retry; surface a friendly message.
      setSlideReset((n) => n + 1);
      if (err instanceof ApiError) {
        const code = err.code;
        if (code === "LIMIT_EXCEEDED" || code === "SCREENING_BLOCK") {
          toast(err.message, "danger");
        } else if (code === "BELOW_GASLESS_MINIMUM" || code === "TRANCHE_BELOW_MINIMUM") {
          toast(err.message, "danger");
        } else if (err.status === 429) {
          toast("You're going too fast — try again in a moment.", "danger");
        } else if (err.message && err.code !== "NOT_SIGNED_IN") {
          toast(err.message, "danger");
        }
      } else if (
        (err as Error)?.message &&
        (err as Error).message !== "not signed in" &&
        (err as Error).message !== "no recipient"
      ) {
        toast("Couldn't set up the contract. Please try again.", "danger");
      }
      throw err;
    }
  }, [hireAndFund, toast]);

  return (
    <Sheet open={open} onClose={onClose} title="New work contract" size="lg">
      <div className="space-y-4">
        <Field label="Who are you paying?" hint="Talise handle, @username, or Sui address">
          <input
            value={payeeInput}
            onChange={(e) => setPayeeInput(e.target.value)}
            placeholder="@alice or 0x…"
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
          />
        </Field>
        {resolving && (
          <div className="flex items-center gap-2 text-[12px] text-[#3d7a29]">
            <Spinner size={13} /> Resolving…
          </div>
        )}
        {resolved && (
          <div className="flex items-center gap-2 rounded-xl bg-[#CAFFB8] px-3 py-2 text-[13px] text-[#15300c]">
            Paying {resolved.displayName}
          </div>
        )}
        {resolveErr && <p className="text-[12px] text-[#c0532f]">{resolveErr}</p>}

        <Field label="Role / title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Senior contractor, design"
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rate per period">
            <div className="flex items-center rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 backdrop-blur-sm focus-within:ring-2 focus-within:ring-[#3d7a29]/45">
              <span className="text-[15px] text-[#3d7a29]">$</span>
              <input
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                placeholder="500"
                className="w-full bg-transparent pl-1 text-[15px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
                style={{ fontVariantNumeric: "tabular-nums" }}
              />
            </div>
          </Field>
          <Field label="Periods" hint={`How many ${cad.period}s to pay`}>
            <input
              value={periods}
              onChange={(e) => setPeriods(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder="4"
              className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
              style={{ fontVariantNumeric: "tabular-nums" }}
            />
          </Field>
        </div>

        {/* Cadence selector */}
        <div>
          <Eyebrow className="mb-2.5 block">Cadence</Eyebrow>
          <Segmented<Cadence>
            value={cadence}
            onChange={setCadence}
            options={CADENCES.map((c) => ({ value: c.id, label: c.label }))}
            ariaLabel="Pay cadence"
          />
        </div>

        {/* Live preview */}
        <div className="rounded-xl border border-[#15300c]/10 bg-white/60 px-4 py-4 backdrop-blur-sm">
          {total > 0 ? (
            <>
              <p className="text-[14px] leading-relaxed text-[#15300c]">
                Pays{" "}
                <span className="font-medium text-[#3d7a29]">{previewName}</span>{" "}
                {formatUsd(rateNum, { fixed: true })} every {cad.period} for {periodsNum}{" "}
                {cad.period}
                {periodsNum === 1 ? "" : "s"}.
              </p>
              <div className="mt-3 flex items-center justify-between">
                <MicroLabel>Funded now</MicroLabel>
                <span
                  className="text-[22px] font-semibold text-[#15300c]"
                  style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                >
                  {formatUsd(total, { fixed: true })}
                </span>
              </div>
              <p className="mt-1.5 text-[12px] text-[#3d7a29]">
                Funded once, gas is on us. Each {cad.period}&apos;s pay releases
                automatically; cancel anytime to get the unsent balance back.
              </p>
            </>
          ) : (
            <p className="text-[13px] text-[#3d7a29]">
              Set a rate and number of periods to preview the total.
            </p>
          )}
        </div>

        <SlideToConfirm
          label="Slide to hire & fund"
          onConfirm={onConfirm}
          disabled={!ready}
          resetSignal={slideReset}
        />
      </div>
    </Sheet>
  );
}
