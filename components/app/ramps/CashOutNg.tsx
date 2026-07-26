"use client";

/**
 * CashOutNg — USDsui → NGN bank cash-out, as a full page (via Linq).
 *
 * Full-page version of the old WithdrawToBankSheet. Linq hands back a deposit
 * wallet it watches: the user sends USDsui there and Linq pays the bank, so
 * there's NO Talise treasury and NO on-chain receipt check here.
 *   form → review (quote) → send + poll → result.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Alert02Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import {
  Field,
  PrimaryButton,
  SlideToConfirm,
  Eyebrow,
  useToast,
  useSignAndSend,
  api,
  ApiError,
} from "@/components/app";
import { BackButton } from "@/components/app/ui/BackButton";
import { LINQ_BANKS } from "@/lib/linq-banks";
import { BankSelect } from "@/components/app/ui/BankSelect";

type Quote = {
  accountName: string;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  rate: number;
  amountUsdsui: number;
  amountNgn: number;
};
type CreateResp = {
  orderId: string;
  linqOrderId: string;
  walletAddress: string;
  coinType: string;
  amountUsdsui: number;
  amountNgn: number;
  rate: number;
  depositWindowMinutes: number;
};
type StatusResp = {
  orderId: string;
  status: string;
  phase: "initiated" | "processing" | "completed" | "failed";
  amountUsdsui: number;
  amountNgn: number;
};

const ngn = (n: number) => "₦" + n.toLocaleString("en-NG", { maximumFractionDigits: 0 });
const usd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cardCls = "rounded-[28px] bg-[#f7fcf2] p-5 sm:p-6";
const cardStyle = { boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" };

export function CashOutNg() {
  const router = useRouter();
  const { toast } = useToast();
  const { send } = useSignAndSend();

  const [step, setStep] = useState<"form" | "review" | "result">("form");
  const [amount, setAmount] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [finalStatus, setFinalStatus] = useState<"settled" | "remitting" | "failed" | null>(null);
  const [resetSignal] = useState(0);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep("form");
    setAmount("");
    setAccount("");
    setError(null);
    setQuote(null);
    setFinalStatus(null);
    setBusy(false);
  }, []);

  // Name-enquiry once a bank + full 10-digit account are present (debounced).
  useEffect(() => {
    if (step !== "form") return;
    if (!bankCode || !/^\d{10}$/.test(account)) {
      setResolvedName(null);
      setResolveErr(null);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    setResolveErr(null);
    setResolvedName(null);
    const t = setTimeout(async () => {
      try {
        const r = await api<{ accountName: string }>("/api/offramp/linq/resolve", {
          method: "POST",
          body: { bankCode, accountNumber: account },
        });
        if (!cancelled) setResolvedName(r.accountName);
      } catch (e) {
        if (!cancelled)
          setResolveErr(e instanceof ApiError ? e.message : "Couldn't verify that account.");
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bankCode, account, step]);

  const amountUsdsui = Number(amount) || 0;
  const formValid =
    amountUsdsui > 0 && /^\d{10}$/.test(account) && !!bankCode && !!resolvedName && !resolveErr;

  async function getQuote() {
    setError(null);
    setBusy(true);
    try {
      const q = await api<Quote>("/api/offramp/linq/quote", {
        method: "POST",
        body: { amountUsdsui, bankCode, accountNumber: account },
      });
      setQuote(q);
      setStep("review");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not build a quote. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithdraw() {
    if (!quote) return;
    try {
      const order = await api<CreateResp>("/api/offramp/linq/create", {
        method: "POST",
        body: {
          amountUsdsui: quote.amountUsdsui,
          bankCode: quote.bankCode,
          accountNumber: quote.accountNumber,
          accountName: quote.accountName,
          bankName: quote.bankName,
        },
      });
      await send({ to: order.walletAddress, amountUsd: order.amountUsdsui, asset: "USDsui" });
      let settled: "settled" | "remitting" | "failed" = "remitting";
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const s = await api<StatusResp>(`/api/offramp/linq/status/${order.orderId}`);
          if (s.phase === "completed") { settled = "settled"; break; }
          if (s.phase === "failed") { settled = "failed"; break; }
        } catch {
          /* transient poll error, keep trying */
        }
      }
      setFinalStatus(settled);
      setStep("result");
      if (settled !== "failed") toast("Withdrawal submitted.", "success");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Withdrawal failed.";
      setError(msg);
      setFinalStatus("failed");
      setStep("result");
    }
  }

  const bankName = LINQ_BANKS.find((b) => b.bankCode === bankCode)?.name ?? bankCode;

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 pb-16 pt-2">
      <div className="space-y-3">
        <BackButton href="/app/ramps" label="Ramps" />
        <div>
          <Eyebrow>Cash out · Nigeria</Eyebrow>
          <h1
            className="mt-1 text-[clamp(24px,4.5vw,34px)] font-[500] leading-[1.05] tracking-[-0.05em] text-[#15300c]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
          >
            Cash out to your bank
          </h1>
        </div>
      </div>

      {step === "form" && (
        <div className={cardCls} style={cardStyle}>
          <div className="space-y-5">
            <Field label="Amount (USDsui)" hint="The amount you send from your wallet.">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
                className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-[18px] text-[#15300c] placeholder:text-[#3d7a29] outline-none backdrop-blur-sm focus:border-[#3d7a29] focus:ring-1 focus:ring-[#3d7a29]"
              />
            </Field>
            <Field label="Bank">
              <BankSelect banks={LINQ_BANKS} value={bankCode} onChange={setBankCode} />
            </Field>
            <Field label="Account number">
              <input
                inputMode="numeric"
                value={account}
                onChange={(e) => setAccount(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
                placeholder="0123456789"
                className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-[16px] tracking-wide text-[#15300c] placeholder:text-[#3d7a29] outline-none backdrop-blur-sm focus:border-[#3d7a29] focus:ring-1 focus:ring-[#3d7a29]"
              />
            </Field>
            {resolving && <p className="-mt-2 text-[13px] text-[#3d7a29]">Checking account…</p>}
            {resolvedName && !resolving && (
              <p className="-mt-2 flex items-center gap-1.5 text-[13px] font-medium text-[#3d7a29]">
                <HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} strokeWidth={2} />
                {resolvedName}
              </p>
            )}
            {resolveErr && !resolving && <p className="-mt-2 text-[13px] text-[#c0532f]">{resolveErr}</p>}
            {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}
            <PrimaryButton full onClick={getQuote} disabled={!formValid || busy} loading={busy}>
              {busy ? "Getting quote…" : "Continue"}
            </PrimaryButton>
          </div>
        </div>
      )}

      {step === "review" && quote && (
        <div className="space-y-5">
          <div className={cardCls} style={cardStyle}>
            <Eyebrow>They receive</Eyebrow>
            <div className="mt-1 text-[28px] font-semibold tabular-nums tracking-[-0.05em] text-[#3d7a29]">
              {ngn(quote.amountNgn)}
            </div>
            <div className="mt-4 divide-y divide-[#15300c]/10 text-[13px]">
              <Row k="To" v={quote.accountName} />
              <Row k="Bank" v={bankName} />
              <Row k="Account" v={`••••${account.slice(-4)}`} />
              <Row k="You send" v={usd(quote.amountUsdsui) + " USDsui"} />
              <Row k="Rate" v={`$1 = ${ngn(quote.rate)}`} />
            </div>
          </div>
          <p className="text-center text-[12px] text-[#3d7a29]">Rate locks when you confirm. Slide to withdraw.</p>
          {error && <p className="text-center text-[13px] text-[#c0532f]">{error}</p>}
          <SlideToConfirm label="Slide to withdraw" onConfirm={confirmWithdraw} resetSignal={resetSignal} />
          <button
            type="button"
            onClick={() => { setStep("form"); setError(null); }}
            className="mx-auto block text-[13px] text-[#3a5230] underline-offset-2 hover:underline"
          >
            Edit details
          </button>
        </div>
      )}

      {step === "result" && (
        <div className={cardCls} style={cardStyle}>
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            {finalStatus === "failed" ? (
              <>
                <span className="flex size-12 items-center justify-center rounded-full bg-[#FF9E7A] text-[#c0532f]">
                  <HugeiconsIcon icon={Alert02Icon} size={24} strokeWidth={2} />
                </span>
                <div>
                  <h3 className="text-[18px] font-medium tracking-[-0.05em] text-[#15300c]">Payout failed</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-[#3a5230]">
                    {error ?? "The payout could not be completed."}
                  </p>
                </div>
                <PrimaryButton full onClick={reset}>Try again</PrimaryButton>
              </>
            ) : (
              <>
                <span
                  className={`flex size-12 items-center justify-center rounded-full text-[#15300c] ${
                    finalStatus === "settled" ? "bg-[#CAFFB8]" : "bg-[#FFE59E]"
                  }`}
                >
                  <HugeiconsIcon
                    icon={finalStatus === "settled" ? CheckmarkCircle02Icon : Clock01Icon}
                    size={24}
                    strokeWidth={2}
                  />
                </span>
                <div>
                  <h3 className="text-[18px] font-medium tracking-[-0.05em] text-[#15300c]">
                    {finalStatus === "settled" ? "Paid out" : "On its way"}
                  </h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-[#3a5230]">
                    {quote ? ngn(quote.amountNgn) : ""} to {quote?.accountName ?? "your bank"}
                    {finalStatus === "settled" ? " has landed." : ". Banks usually settle in seconds."}
                  </p>
                </div>
                <PrimaryButton full onClick={() => router.push("/app/ramps")}>Done</PrimaryButton>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-[#3d7a29]">{k}</span>
      <span className="text-right font-medium text-[#15300c]">{v}</span>
    </div>
  );
}

export default CashOutNg;
