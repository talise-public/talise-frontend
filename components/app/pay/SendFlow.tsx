"use client";

/**
 * SendFlow — the web Send experience for /app/pay.
 *
 * A clean multi-step flow that mirrors the iOS Send screens in the website's
 * brand language:
 *
 *   amount  →  recipient  →  review  →  (slide to send)  →  success | failure
 *
 * Amount entry is a big AmountDisplay-style headline you can type with the
 * keyboard (desktop) or the on-screen Numpad (mobile). Recipient resolution is
 * debounced via resolveRecipient(), with recent contacts as quick chips. Money
 * moves only through useSignAndSend(); the API client surfaces server `code`s
 * (429 / LIMIT_EXCEEDED / SCREENING_BLOCK / BELOW_GASLESS_MINIMUM) which we map
 * to friendly inline copy.
 *
 * Deep-link prefill: ?to=&amount= seeds the recipient and amount so the public
 * /pay/<handle> link and Home quick-send can drop the user straight into review.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Alert02Icon,
  CheckmarkBadge01Icon,
  PlusSignIcon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import {
  GlassCard,
  Eyebrow,
  MicroLabel,
  PrimaryButton,
  SlideToConfirm,
  Spinner,
  Numpad,
  useBalances,
  useContacts,
  useMe,
  useCurrency,
  useToast,
  useSignAndSend,
  resolveRecipient,
  ApiError,
  type Contact,
} from "@/components/app";
import { AtomicFlowReceipt } from "@/components/app/pay/AtomicFlowReceipt";
// framer-motion only loads when a send actually succeeds — keep it out of the
// Send page's initial bundle.
const CoinBurst = dynamic(
  () => import("@/components/app/anim/CoinBurst").then((m) => ({ default: m.CoinBurst })),
  { ssr: false }
);

const EXPLORER = "https://suiscan.xyz/mainnet/tx/";

type Step = "amount" | "recipient" | "review" | "success" | "failure";

type Resolved = { address: string; displayName: string };

// ── Error copy ───────────────────────────────────────────────────────────────

/** Turn an ApiError into a short, friendly, actionable inline message. */
function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "LIMIT_EXCEEDED":
        return "This send is over your current limit. Try a smaller amount.";
      case "SCREENING_BLOCK":
        return "We couldn't complete this transfer. Please contact support if this keeps happening.";
      case "BELOW_GASLESS_MINIMUM":
        return "That's below the minimum gasless send. Try a slightly larger amount.";
      case "NOT_SIGNED_IN":
        return "Sign in to continue — we'll bring you right back.";
      case "NETWORK":
        return "Network error — check your connection and try again.";
    }
    if (e.status === 429) return "You're going a little fast. Wait a moment and try again.";
    if (e.status === 401) return "Your session expired. Sign in again to send.";
    if (e.message) return e.message;
  }
  return "Something went wrong. No funds moved.";
}

// ── Amount math ───────────────────────────────────────────────────────────────

/** Group the integer part of a typed decimal string with thousands commas. */
function groupDigits(intPart: string): string {
  if (intPart.length <= 3 || !/^\d+$/.test(intPart)) return intPart;
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── Stepper ───────────────────────────────────────────────────────────────────

const FLOW_STEPS: { key: Step; label: string }[] = [
  { key: "amount", label: "Amount" },
  { key: "recipient", label: "Recipient" },
  { key: "review", label: "Review" },
  { key: "success", label: "Pay" },
];

function stepIndex(step: Step): number {
  if (step === "failure") return 3; // treat failure same as the Pay step position
  return FLOW_STEPS.findIndex((s) => s.key === step);
}

function FlowStepper({ step }: { step: Step }) {
  const active = stepIndex(step);
  // success/failure → all 4 filled
  const filled = step === "success" || step === "failure" ? 4 : active;

  return (
    // Slightly inset on mobile (88%, centered) — full-bleed it ran edge to
    // edge under the sheet's close button and read too wide.
    <div className="mx-auto mb-4 w-[88%] sm:mb-5 sm:w-full" aria-label="Send progress">
      {/* Progress bar */}
      <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-[#15300c]/10">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[#3d7a29] transition-all duration-300"
          style={{ width: `${(filled / (FLOW_STEPS.length - 1)) * 100}%` }}
        />
      </div>
      {/* Step labels — only the current step reads at full weight; the others
          sit back as quiet 9px markers so the row stops competing for attention. */}
      <div className="mt-2 flex items-center justify-between">
        {FLOW_STEPS.map((s, i) => {
          const done = i < filled;
          const current = i === active && step !== "success" && step !== "failure";
          return (
            <span
              key={s.key}
              className={`font-mono tracking-[0.08em] transition-colors ${
                current
                  ? "text-[10px] font-medium text-[#15300c]"
                  : done
                    ? "text-[9px] text-[#3d7a29]"
                    : "text-[9px] text-[#3d7a29]/60"
              }`}
            >
              {s.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SendFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: balances } = useBalances();
  const { me } = useMe();
  const { symbol, formatLocal, toLocal, rate } = useCurrency();
  const { toast } = useToast();
  const { send, sending } = useSignAndSend();

  const [step, setStep] = useState<Step>("amount");
  // The raw typed string is in the user's DISPLAY currency (matches iOS).
  const [raw, setRaw] = useState("");
  const [recipientInput, setRecipientInput] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolving, setResolving] = useState(false);
  const [noMatch, setNoMatch] = useState(false);

  const [digest, setDigest] = useState<string | null>(null);
  // Server-blessed send outcome (rail + Save leg), captured for the atomic
  // receipt + gasless indicator on the success screen. See useSignAndSend.
  const [sendMode, setSendMode] = useState<string>("");
  const [savedUsd, setSavedUsd] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  // When this send is paying a public invoice (?invoice=<id>), close it after
  // the on-chain payment lands — verified server-side at /api/invoices/<id>/settle.
  const invoiceId = params.get("invoice");
  const [invoiceSettle, setInvoiceSettle] =
    useState<"idle" | "pending" | "paid" | "error" | "unmatched">("idle");
  const [unmatchedMsg, setUnmatchedMsg] = useState<string | null>(null);

  const { contacts } = useContacts();

  // Display-currency typed value → USD (USDsui). FX `rate` is local-per-USD.
  const typedLocal = raw ? parseFloat(raw) : 0;
  const amountUsd = useMemo(() => {
    if (!Number.isFinite(typedLocal) || typedLocal <= 0) return 0;
    return rate > 0 ? typedLocal / rate : typedLocal;
  }, [typedLocal, rate]);

  const balancesKnown = balances != null;
  const available = balances?.usdsui ?? 0;
  // Don't flag "over balance" until we actually know the balance — otherwise a
  // cold load flashes the warning (and a ₦0 wallet pill) before the snapshot lands.
  const overBalance = balancesKnown && amountUsd > 0 && amountUsd > available + 1e-9;
  const canReview = amountUsd > 0 && !overBalance;

  // ── Deep-link prefill (?to=&amount=) ──────────────────────────────────────
  // Recipient prefill is one-shot. Amount prefill is rate-aware: the link
  // amount is in USD, so we seed `raw` (a display-currency string) and re-seed
  // once live FX rates land — but only while the user hasn't typed yet, so we
  // never clobber their edits.
  const recipientPrefillDone = useRef(false);
  const userTouchedAmount = useRef(false);
  const linkAmountUsd = useMemo(() => {
    const amt = params.get("amount");
    if (amt && /^\d*\.?\d*$/.test(amt)) {
      const v = parseFloat(amt);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  }, [params]);

  useEffect(() => {
    if (userTouchedAmount.current || linkAmountUsd == null) return;
    const local = rate > 0 ? linkAmountUsd * rate : linkAmountUsd;
    setRaw(local % 1 === 0 ? String(Math.round(local)) : local.toFixed(2));
  }, [linkAmountUsd, rate]);

  useEffect(() => {
    if (recipientPrefillDone.current) return;
    const to = params.get("to");
    if (to) {
      recipientPrefillDone.current = true;
      setRecipientInput(to);
      void runResolve(to, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // ── Keyboard amount entry (desktop) ───────────────────────────────────────
  const onAmountKey = useCallback((d: string) => {
    userTouchedAmount.current = true;
    setRaw((prev) => {
      if (d === ".") {
        if (prev.includes(".")) return prev;
        return prev === "" ? "0." : prev + ".";
      }
      // limit to 2 decimal places
      const dot = prev.indexOf(".");
      if (dot >= 0 && prev.length - dot > 2) return prev;
      if (prev === "0" && d !== ".") return d;
      if (prev.length >= 12) return prev;
      return prev + d;
    });
  }, []);
  const onBackspace = useCallback(() => {
    userTouchedAmount.current = true;
    setRaw((p) => p.slice(0, -1));
  }, []);

  useEffect(() => {
    if (step !== "amount") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        onAmountKey(e.key);
      } else if (e.key === ".") {
        onAmountKey(".");
      } else if (e.key === "Backspace") {
        onBackspace();
      } else if (e.key === "Enter" && canReview) {
        setStep("recipient");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, onAmountKey, onBackspace, canReview]);

  const setMax = useCallback(() => {
    if (available <= 0) return;
    userTouchedAmount.current = true;
    // Floor to 2dp (never round UP) — rounding the FX-converted local value up
    // would push the implied USD a fraction over `available` and trip the
    // "over balance" guard, blocking Continue on non-USD currencies.
    const local = Math.floor(toLocal(available) * 100) / 100;
    setRaw(local.toFixed(2));
  }, [available, toLocal]);

  // ── Recipient resolution (debounced) ──────────────────────────────────────
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveSeq = useRef(0);

  const runResolve = useCallback(async (qRaw: string, immediate = false) => {
    const q = qRaw.trim();
    setResolved(null);
    setNoMatch(false);
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    if (q.length < 3) {
      setResolving(false);
      return;
    }
    // A raw 0x address resolves to itself instantly (no round trip).
    if (/^0x[0-9a-fA-F]{6,}$/.test(q)) {
      setResolved({ address: q, displayName: `${q.slice(0, 8)}…${q.slice(-6)}` });
      setResolving(false);
      return;
    }
    const seq = ++resolveSeq.current;
    setResolving(true);
    const fire = async () => {
      try {
        const r = await resolveRecipient(q);
        if (seq !== resolveSeq.current) return;
        setResolved(r);
        setNoMatch(false);
      } catch {
        if (seq !== resolveSeq.current) return;
        setResolved(null);
        setNoMatch(true);
      } finally {
        if (seq === resolveSeq.current) setResolving(false);
      }
    };
    if (immediate) {
      await fire();
    } else {
      resolveTimer.current = setTimeout(fire, 280);
    }
  }, []);

  const onRecipientChange = useCallback(
    (v: string) => {
      setRecipientInput(v);
      void runResolve(v);
    },
    [runResolve]
  );

  const pickContact = useCallback(
    (c: Contact) => {
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
      resolveSeq.current++; // invalidate any pending resolve
      setResolving(false);
      setNoMatch(false);
      setRecipientInput(c.name ?? c.address);
      setResolved({
        address: c.address,
        displayName: c.name ?? `${c.address.slice(0, 8)}…${c.address.slice(-6)}`,
      });
      setStep("review");
    },
    []
  );

  // Close the invoice once payment lands. Settlement is verified on-chain
  // server-side, so we just hand over the digest; retry a few times to ride out
  // RPC indexing lag right after broadcast.
  const settleInvoice = useCallback(async (id: string, d: string) => {
    setInvoiceSettle("pending");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/api/invoices/${encodeURIComponent(id)}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ digest: d }),
        });
        if (res.ok) {
          setInvoiceSettle("paid");
          return;
        }
        // Distinguish a PERMANENT mismatch (wrong amount/recipient, already
        // settled, void) from transient RPC indexing lag. Only the latter is
        // worth retrying — a permanent failure must not masquerade as lag.
        let payload: { error?: string } = {};
        try {
          payload = await res.json();
        } catch {
          /* ignore */
        }
        const transient =
          res.status === 429 ||
          (res.status === 400 &&
            /^could not verify payment yet/i.test(payload.error ?? ""));
        if (!transient) {
          setUnmatchedMsg(payload.error ?? null);
          setInvoiceSettle("unmatched");
          return;
        }
      } catch {
        /* network blip — retry */
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    // Exhausted transient retries — the payment landed; settlement just lagged.
    setInvoiceSettle("error");
  }, []);

  // ── Confirm ────────────────────────────────────────────────────────────────
  const onConfirm = useCallback(async () => {
    if (!resolved) return;
    setErrorMsg(null);
    try {
      // When paying an invoice the user hasn't manually edited, send the exact
      // canonical USD from the pay link — not the value round-tripped through
      // the payer's display-currency FX, which lands a few micro-units short
      // and makes on-chain settlement reject (the invoice would never close).
      const amountToSend =
        invoiceId && !userTouchedAmount.current && linkAmountUsd != null
          ? linkAmountUsd
          : amountUsd;
      const { digest: d, mode, roundupUsd } = await send({
        to: resolved.address,
        amountUsd: amountToSend,
      });
      setDigest(d);
      setSendMode(mode);
      setSavedUsd(roundupUsd);
      setStep("success");
      if (invoiceId) void settleInvoice(invoiceId, d);
    } catch (e) {
      // NOT_SIGNED_IN bounces to OAuth inside useSignAndSend — don't show a
      // failure screen for that, just let the redirect happen.
      if (e instanceof ApiError && e.code === "NOT_SIGNED_IN") return;
      setErrorMsg(friendlyError(e));
      setStep("failure");
      throw e; // let SlideToConfirm spring back
    }
  }, [resolved, amountUsd, send, invoiceId, settleInvoice, linkAmountUsd]);

  const resetAll = useCallback(() => {
    setStep("amount");
    setRaw("");
    setRecipientInput("");
    setResolved(null);
    setNoMatch(false);
    setDigest(null);
    setSendMode("");
    setSavedUsd(0);
    setErrorMsg(null);
    setResetSignal((s) => s + 1);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  const recentContacts = contacts.slice(0, 8);
  const showStepper = step !== "success" && step !== "failure";

  return (
    <div className="mx-auto w-full max-w-md">
      {/* Back / Close nav row — sits above the stepper. The centered mono step
          title used to live here, but it just repeated the active Pay tab
          (Send) and the stepper below already names every step, so it's gone.
          On the amount step there's no Back, so the row collapses to a single
          right-aligned Close. On later steps Back carries real navigation. */}
      {showStepper && (
        <div className="mb-3 flex items-center justify-between">
          {step !== "amount" ? (
            <button
              type="button"
              onClick={() => {
                if (step === "recipient") setStep("amount");
                else if (step === "review") setStep("recipient");
              }}
              aria-label="Back"
              className="flex size-9 items-center justify-center rounded-full border border-[#15300c]/15 bg-white/60 text-[#15300c] backdrop-blur-sm transition-colors hover:border-[#15300c]/30"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={18} strokeWidth={2} />
            </button>
          ) : (
            <span />
          )}

          <button
            type="button"
            onClick={() => router.push("/app")}
            aria-label="Close"
            className="flex size-9 items-center justify-center rounded-full border border-[#15300c]/15 bg-white/60 text-[#3a5230] backdrop-blur-sm transition-colors hover:border-[#15300c]/30"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
          </button>
        </div>
      )}

      {showStepper && <FlowStepper step={step} />}

      {step === "amount" && (
        <AmountStep
          raw={raw}
          symbol={symbol}
          amountUsd={amountUsd}
          overBalance={overBalance}
          available={available}
          availableLabel={balancesKnown ? formatLocal(available) : "—"}
          canReview={canReview}
          onKey={onAmountKey}
          onBackspace={onBackspace}
          onMax={setMax}
          onNext={() => setStep("recipient")}
        />
      )}

      {step === "recipient" && (
        <RecipientStep
          value={recipientInput}
          resolving={resolving}
          resolved={resolved}
          noMatch={noMatch}
          contacts={recentContacts}
          onChange={onRecipientChange}
          onClear={() => onRecipientChange("")}
          onPickContact={pickContact}
          onNext={() => setStep("review")}
        />
      )}

      {step === "review" && resolved && (
        <ReviewStep
          amountUsd={amountUsd}
          fromHandle={me?.taliseHandle ? `${me.taliseHandle}@talise` : "your wallet"}
          fromAddress={me?.suiAddress ?? ""}
          to={resolved}
          sending={sending}
          resetSignal={resetSignal}
          onConfirm={onConfirm}
        />
      )}

      {step === "success" && digest && (
        <>
          <SuccessStep
            amountUsd={amountUsd}
            to={resolved}
            digest={digest}
            mode={sendMode}
            savedUsd={savedUsd}
            onShareCopied={() => toast("Receipt link copied", "success")}
            onDone={() => router.push("/app")}
            onAgain={resetAll}
          />
          {invoiceId && (
            <div className="mx-auto mt-4 flex max-w-md items-center justify-center gap-2 text-[13px]">
              {invoiceSettle === "paid" ? (
                <span className="text-[#3d7a29]">✓ Invoice marked paid</span>
              ) : invoiceSettle === "pending" ? (
                <span className="text-[#3d7a29]">Confirming invoice…</span>
              ) : invoiceSettle === "unmatched" ? (
                <span className="text-[#c0532f]">
                  Payment sent, but it didn&apos;t match this invoice
                  {unmatchedMsg ? ` (${unmatchedMsg})` : ""}.
                </span>
              ) : invoiceSettle === "error" ? (
                <span className="text-[#3d7a29]">Payment sent — invoice will update shortly</span>
              ) : null}
              <a
                href={`/i/${invoiceId}`}
                className="text-[#3a5230] underline underline-offset-2 hover:text-[#15300c]"
              >
                View invoice
              </a>
            </div>
          )}
        </>
      )}

      {step === "failure" && (
        <FailureStep
          message={errorMsg}
          onTryAgain={() => {
            setErrorMsg(null);
            setResetSignal((s) => s + 1);
            setStep("review");
          }}
          onDone={() => router.push("/app")}
        />
      )}
    </div>
  );
}

// ── Step 1: Amount ─────────────────────────────────────────────────────────────

function AmountStep({
  raw,
  symbol,
  amountUsd,
  overBalance,
  available,
  availableLabel,
  canReview,
  onKey,
  onBackspace,
  onMax,
  onNext,
}: {
  raw: string;
  symbol: string;
  amountUsd: number;
  overBalance: boolean;
  available: number;
  availableLabel: string;
  canReview: boolean;
  onKey: (d: string) => void;
  onBackspace: () => void;
  onMax: () => void;
  onNext: () => void;
}) {
  const display = useMemo(() => {
    if (!raw) return "0";
    const dot = raw.indexOf(".");
    if (dot >= 0) return `${groupDigits(raw.slice(0, dot))}.${raw.slice(dot + 1)}`;
    return groupDigits(raw);
  }, [raw]);

  const usdsuiLine = `${amountUsd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDsui`;

  return (
    <div>
      {/* Big ink amount — Wise layout: currency chip inline with the number */}
      <div className="flex flex-col items-center py-3 text-center sm:py-6">
        <div className="flex items-baseline justify-center gap-2">
          {/* Currency chip */}
          <span className="mb-1 self-end rounded-full border border-[#15300c]/15 bg-white/60 px-2.5 py-1 font-mono text-[13px] font-medium text-[#3a5230] backdrop-blur-sm">
            {symbol}
          </span>
          {/* Big ink number */}
          <span
            className={`font-[800] tabular-nums ${
              overBalance ? "text-[#c0532f]" : "text-[#15300c]"
            }`}
            style={{ fontFamily: "var(--font-display-v2)", fontSize: 48, lineHeight: 1.02, letterSpacing: "-0.04em" }}
          >
            {display}
          </span>
        </div>

        {/* USDsui sublabel */}
        <span className="mt-2 font-mono text-[12px] tabular-nums text-[#3d7a29]">{usdsuiLine}</span>

        {overBalance && (
          <span className="mt-1.5 rounded-full bg-[#FF9E7A]/30 px-3 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#c0532f]">
            Over available balance
          </span>
        )}
      </div>

      {/* Wallet pill + MAX */}
      <div className="mb-4 flex items-center justify-center gap-2 sm:mb-5">
        <span className="inline-flex items-center gap-2 rounded-full border border-[#15300c]/15 bg-white/60 px-3.5 py-1.5 backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-[#3d7a29]" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#15300c]">
            Main wallet
          </span>
          <span className="font-mono text-[10px] text-[#3d7a29]">· {availableLabel}</span>
        </span>
        <button
          type="button"
          onClick={onMax}
          disabled={available <= 0}
          className="rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[#3d7a29] backdrop-blur-sm transition-colors hover:border-[#15300c]/30 disabled:opacity-40"
        >
          Max
        </button>
      </div>

      {/* Numpad — shown on mobile; desktop users can type with the keyboard. */}
      <Numpad onKey={onKey} onBackspace={onBackspace} className="lg:hidden" />
      <p className="mt-1 hidden text-center text-[12px] text-[#3d7a29] lg:block">
        Type an amount, then press Enter to continue.
      </p>

      <div className="mt-4 sm:mt-6">
        <PrimaryButton full disabled={!canReview} onClick={onNext}>
          Continue
        </PrimaryButton>
      </div>
    </div>
  );
}

// ── Step 2: Recipient ───────────────────────────────────────────────────────────

function contactInitials(c: Contact): string {
  const src = (c.name ?? c.address).replace(/@?talise\.sui|\.sui/gi, "");
  const parts = src.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0][0] && parts[1][0]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  const trimmed = src.replace(/^0x/i, "");
  return trimmed.slice(0, 2).toUpperCase();
}

function RecipientStep({
  value,
  resolving,
  resolved,
  noMatch,
  contacts,
  onChange,
  onClear,
  onPickContact,
  onNext,
}: {
  value: string;
  resolving: boolean;
  resolved: Resolved | null;
  noMatch: boolean;
  contacts: Contact[];
  onChange: (v: string) => void;
  onClear: () => void;
  onPickContact: (c: Contact) => void;
  onNext: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div>
      {/* Input */}
      <GlassCard radius={28} className="px-4 py-3.5">
        <Eyebrow className="mb-1.5 block">To</Eyebrow>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && resolved) onNext();
            }}
            placeholder="alice · 0x6487… · alice.sui"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full bg-transparent text-[16px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
          />
          {value && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear"
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-[#3d7a29] transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c]"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      </GlassCard>

      {/* Resolve status */}
      <div className="mt-3 min-h-[20px] px-1">
        {resolving ? (
          <span className="inline-flex items-center gap-2 text-[#3d7a29]">
            <Spinner size={13} />
            <MicroLabel>Resolving…</MicroLabel>
          </span>
        ) : resolved ? (
          <span className="inline-flex items-center gap-1.5">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={14}
              color="#3d7a29"
              strokeWidth={2}
            />
            <span className="font-mono text-[11px] text-[#3d7a29]">{resolved.displayName}</span>
            <span className="font-mono text-[10px] text-[#3d7a29]">
              {resolved.address.slice(0, 8)}…{resolved.address.slice(-6)}
            </span>
          </span>
        ) : noMatch && value.trim().length >= 3 ? (
          <span className="inline-flex items-center gap-1.5">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={14}
              color="#c0532f"
              strokeWidth={2}
            />
            <span className="font-mono text-[11px] text-[#c0532f]">
              No match for &ldquo;{value.trim()}&rdquo;
            </span>
          </span>
        ) : null}
      </div>

      {/* Recent contacts */}
      <div className="mt-6">
        <Eyebrow className="mb-3 block">Recent</Eyebrow>
        {contacts.length === 0 ? (
          <p className="text-[13px] text-[#3d7a29]">
            No recent recipients yet — your first send will appear here.
          </p>
        ) : (
          <div className="overflow-hidden rounded-[28px] border border-[#15300c]/15 bg-white/60 backdrop-blur-sm">
            {contacts.map((c, i) => (
              <button
                key={c.address}
                type="button"
                onClick={() => onPickContact(c)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[#CAFFB8]/50 ${
                  i < contacts.length - 1 ? "border-b border-[#15300c]/10" : ""
                }`}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[12px] font-[800] text-[#15300c]" style={{ fontFamily: "var(--font-display-v2)" }}>
                  {contactInitials(c)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-[#15300c]">
                    {c.name ?? `${c.address.slice(0, 8)}…${c.address.slice(-6)}`}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-[#3d7a29]">
                    {c.address.slice(0, 10)}…{c.address.slice(-6)}
                  </span>
                </span>
                {c.sentCount > 0 && (
                  <span className="shrink-0 font-mono text-[10px] text-[#3d7a29]">
                    {c.sentCount}×
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        <PrimaryButton full disabled={!resolved} onClick={onNext}>
          Continue
        </PrimaryButton>
      </div>
    </div>
  );
}

// ── Step 3: Review ──────────────────────────────────────────────────────────────

/** Single detail row in the review list — circular chip + title + sublabel + trailing value. */
function ReviewRow({
  chip,
  title,
  sub,
  value,
  valueSub,
  last = false,
}: {
  chip: React.ReactNode;
  title: string;
  sub: string;
  value: string;
  valueSub?: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3.5 px-5 py-4 ${
        !last ? "border-b border-[#15300c]/10" : ""
      }`}
    >
      {chip}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-[#15300c]">{title}</span>
        <span className="block truncate font-mono text-[11px] text-[#3d7a29]">{sub}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span className="text-[14px] font-semibold tabular-nums text-[#15300c]">{value}</span>
        {valueSub && (
          <span className="mt-0.5 font-mono text-[10px] text-[#3d7a29]">{valueSub}</span>
        )}
      </span>
    </div>
  );
}

function ReviewChip({ letter, accent = false }: { letter: string; accent?: boolean }) {
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-[800] ${
        accent ? "bg-[#CAFFB8] text-[#15300c]" : "bg-white/60 text-[#15300c] border border-[#15300c]/15"
      }`}
      style={{ fontFamily: "var(--font-display-v2)" }}
    >
      {letter}
    </span>
  );
}

function ReviewStep({
  amountUsd,
  fromHandle,
  fromAddress,
  to,
  sending,
  resetSignal,
  onConfirm,
}: {
  amountUsd: number;
  fromHandle: string;
  fromAddress: string;
  to: Resolved;
  sending: boolean;
  resetSignal: number;
  onConfirm: () => Promise<void>;
}) {
  const { formatUsd } = useCurrency();

  const usdsuiLine = `${amountUsd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDsui`;

  return (
    <div className="space-y-5">
      {/* Big amount summary */}
      <div className="py-2 text-center">
        <div
          className="font-[800] tabular-nums text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)", fontSize: 40, letterSpacing: "-0.04em", lineHeight: 1.02 }}
        >
          {formatUsd(amountUsd)}
        </div>
        <div className="mt-1.5 font-mono text-[12px] text-[#3d7a29]">{usdsuiLine}</div>
      </div>

      {/* Detail rows — Wise-style list card */}
      <GlassCard radius={28} className="overflow-hidden p-0">
        <ReviewRow
          chip={<ReviewChip letter="F" />}
          title="From"
          sub={fromAddress ? `${fromAddress.slice(0, 10)}…${fromAddress.slice(-6)}` : "your wallet"}
          value={fromHandle}
          last={false}
        />
        <ReviewRow
          chip={<ReviewChip letter={to.displayName[0]?.toUpperCase() ?? "?"} accent />}
          title="To"
          sub={`${to.address.slice(0, 10)}…${to.address.slice(-8)}`}
          value={to.displayName}
          last={false}
        />
        <ReviewRow
          chip={
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[#15300c]/15 bg-white/60 backdrop-blur-sm">
              <HugeiconsIcon
                icon={CheckmarkBadge01Icon}
                size={18}
                color="#3d7a29"
                strokeWidth={2}
              />
            </span>
          }
          title="Network fee"
          sub="Gas sponsored by Talise"
          value="$0.00"
          last={false}
        />
        <ReviewRow
          chip={
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[#15300c]/15 bg-white/60 backdrop-blur-sm">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={18}
                color="#3a5230"
                strokeWidth={2}
              />
            </span>
          }
          title="Arrives"
          sub="Settled on Sui"
          value="< 1 second"
          last
        />
      </GlassCard>

      {/* Slide to send */}
      <SlideToConfirm
        label="Slide to send"
        onConfirm={onConfirm}
        disabled={sending}
        resetSignal={resetSignal}
      />
    </div>
  );
}

// ── Step 4: Success ─────────────────────────────────────────────────────────────

function SuccessStep({
  amountUsd,
  to,
  digest,
  mode,
  savedUsd,
  onShareCopied,
  onDone,
  onAgain,
}: {
  amountUsd: number;
  to: Resolved | null;
  digest: string;
  /** Server rail label: "gasless" | "sponsored" | "sponsored-*-fallback". */
  mode: string;
  /** USD rounded up into NAVI on this send (0 → no Save leg ran). */
  savedUsd: number;
  onShareCopied: () => void;
  onDone: () => void;
  onAgain: () => void;
}) {
  const { formatUsd } = useCurrency();
  const explorerUrl = `${EXPLORER}${digest}`;
  // A4: the gasless rail truly costs the user nothing (validator-sponsored).
  // Other rails are Talise-sponsored — both land $0.00 to the user, so we keep
  // the copy factual and just name how Talise auto-routed it.
  const isGasless = mode === "gasless";

  const copyReceipt = async () => {
    try {
      await navigator.clipboard.writeText(explorerUrl);
      onShareCopied();
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col items-center pt-4 text-center">
      {/* Coins drop + scatter + settle over the amount — the web port of the
          iOS send-success coin drop. Plays once on mount. */}
      <CoinBurst size={140} />

      <Eyebrow className="mt-1">Sent</Eyebrow>
      <div
        className="mt-3 font-[800] tabular-nums text-[#15300c]"
        style={{ fontFamily: "var(--font-display-v2)", fontSize: 44, letterSpacing: "-0.04em" }}
      >
        {formatUsd(amountUsd)}
      </div>
      {to && (
        <p className="mt-2 text-[14px] text-[#3a5230]">
          to <span className="text-[#15300c]">{to.displayName}</span>
        </p>
      )}
      <p className="mt-1 font-mono text-[11px] text-[#3d7a29]">Arrives in &lt;1s</p>

      {/* What happened in one transaction — the atomic PTB made visible. */}
      <div className="mt-6 w-full">
        <AtomicFlowReceipt
          amountText={formatUsd(amountUsd)}
          recipientDisplay={to?.displayName ?? "recipient"}
          savedText={savedUsd > 0 ? formatUsd(savedUsd) : undefined}
          digest={digest}
        />
      </div>

      {/* A4: surface the auto-routed rail. Factual — $0.00 to the user either
          way; only the gasless rail is validator-sponsored at zero network fee. */}
      <p className="mt-3 font-mono text-[11px] text-[#3d7a29]">
        {isGasless
          ? "Gasless · network fee $0.00 — gas sponsored by Talise"
          : "Network fee $0.00 — gas sponsored by Talise"}
      </p>

      <div className="mt-6 flex w-full flex-col gap-2.5">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border-2 border-[#15300c] px-6 py-3 text-[14px] font-medium text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
        >
          View on Suiscan
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={15} strokeWidth={2} />
        </a>
        <button
          type="button"
          onClick={copyReceipt}
          className="text-[13px] font-medium text-[#3d7a29] transition-colors hover:text-[#15300c]"
        >
          Copy receipt link
        </button>
      </div>

      <div className="mt-5 flex w-full flex-col gap-2.5">
        <PrimaryButton full onClick={onDone}>
          Done
        </PrimaryButton>
        <PrimaryButton full variant="ghost" onClick={onAgain}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          Send another
        </PrimaryButton>
      </div>
    </div>
  );
}

// ── Step 5: Failure ─────────────────────────────────────────────────────────────

function FailureStep({
  message,
  onTryAgain,
  onDone,
}: {
  message: string | null;
  onTryAgain: () => void;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col items-center pt-6 text-center">
      <span
        className="mb-5 flex size-16 items-center justify-center rounded-full"
        style={{ background: "color-mix(in srgb, #c0532f 14%, transparent)" }}
      >
        <HugeiconsIcon
          icon={Alert02Icon}
          size={36}
          color="#c0532f"
          strokeWidth={2}
        />
      </span>

      <h2
        className="text-[26px] font-[800] uppercase text-[#15300c]"
        style={{ fontFamily: "var(--font-display-v2)", letterSpacing: "-0.02em" }}
      >
        Send failed
      </h2>
      <p className="mt-1.5 text-[14px] text-[#3a5230]">No funds moved.</p>
      {message && (
        <p className="mt-2 max-w-xs text-[13px] text-[#3d7a29]">{message}</p>
      )}

      <div className="mt-8 flex w-full flex-col gap-2.5">
        <PrimaryButton full onClick={onTryAgain}>
          Try again
        </PrimaryButton>
        <PrimaryButton full variant="ghost" onClick={onDone}>
          Done
        </PrimaryButton>
      </div>
    </div>
  );
}

export default SendFlow;
