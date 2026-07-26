"use client";

/**
 * CashOutUs — USDsui → US bank cash-out, as a full page (via Bridge).
 *
 * Full-page version of the old WithdrawToUsdSheet. Decoupled two-step flow:
 *   KYC gate (inline <KycFlow>) → one-time bank setup → swap USDsui→USDC →
 *   withdraw USDC→wire → "on its way". Signs the two server-prepared sponsored
 *   PTBs. Every step is server-gated (allowlist + KYC-approved + $1 min).
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Alert02Icon, BankIcon } from "@hugeicons/core-free-icons";
import { Field, PrimaryButton, Eyebrow, Spinner, useToast, useBalances, api, ApiError } from "@/components/app";
import { BackButton } from "@/components/app/ui/BackButton";
import { signAndSubmitPreparedBytes } from "@/lib/zkclient";
import { KycFlow } from "./KycFlow";

type Route = {
  address: string;
  currency: string;
  destinationPaymentRail: string;
  bankName?: string | null;
  accountLast4?: string | null;
  accountOwnerName?: string | null;
  accountType?: string | null;
  usdcMicros?: string;
};
type StatusResp = { started: boolean; status: string };
type SwapResp = { bytes: string; mode: string; amountUsdsui: number; estimatedUsdcMicros: string };
type SendResp = { bytes: string; mode: string; amountUsdc: number; destinationPaymentRail: string };

type Step = "loading" | "kyc" | "bankSetup" | "cashout" | "result" | "closed";

const usd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const microsToUsdc = (m?: string) => (m ? Number(m) / 1e6 : 0);
const KYC_APPROVED = (s?: string) => !!s && s.toLowerCase() === "approved";

const inputCls =
  "w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-[16px] text-[#15300c] placeholder:text-[#3d7a29] outline-none backdrop-blur-sm focus:border-[#3d7a29] focus:ring-1 focus:ring-[#3d7a29]";
const cardCls = "rounded-[24px] bg-[#f7fcf2] p-5 sm:p-6";
const cardStyle = { boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" };

export function CashOutUs() {
  const router = useRouter();
  const { toast } = useToast();
  const { data: balances, refreshFresh: refreshBalances } = useBalances();

  const [step, setStep] = useState<Step>("loading");
  const [route, setRoute] = useState<Route | null>(null);
  const [closedMsg, setClosedMsg] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Bank setup form (US ACH).
  const [ownerName, setOwnerName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [acctType, setAcctType] = useState<"checking" | "savings">("checking");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [postal, setPostal] = useState("");
  const [savingBank, setSavingBank] = useState(false);

  // Swap + withdraw.
  const [swapAmt, setSwapAmt] = useState("");
  const [swapping, setSwapping] = useState(false);
  const [sendAmt, setSendAmt] = useState("");
  const [sending, setSending] = useState(false);
  const [sentAmount, setSentAmount] = useState(0);

  const pocket = microsToUsdc(route?.usdcMicros);
  const usdsuiBal = balances?.usdsui ?? 0;

  const probeRoute = useCallback(async (): Promise<Route | null> => {
    try {
      return await api<Route>("/api/offramp/bridge/cashout-address", {
        method: "POST",
        body: { currency: "usd" },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return null;
      throw e;
    }
  }, []);

  const init = useCallback(async () => {
    setStep("loading");
    setError(null);
    try {
      const s = await api<StatusResp>("/api/kyc/bridge/status");
      if (!KYC_APPROVED(s.status)) {
        setStep("kyc");
        return;
      }
      const r = await probeRoute();
      if (r) {
        setRoute(r);
        setStep("cashout");
      } else {
        setStep("bankSetup");
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === "NO_BRIDGE_CUSTOMER" || e.code === "KYC_NOT_APPROVED")) {
        setStep("kyc");
      } else if (e instanceof ApiError && (e.code === "USD_WITHDRAWAL_CLOSED" || e.status === 503)) {
        setClosedMsg(e.message || "US cash-out isn't switched on yet.");
        setStep("closed");
      } else {
        setClosedMsg(e instanceof ApiError ? e.message : "Couldn't load cash-out. Try again.");
        setStep("closed");
      }
    }
  }, [probeRoute]);

  useEffect(() => {
    init();
  }, [init]);

  // ── bank setup ──
  const canSaveBank =
    ownerName.trim().length > 1 &&
    /^\d{4,17}$/.test(accountNumber) &&
    /^\d{9}$/.test(routingNumber) &&
    street.trim().length > 2 &&
    city.trim().length > 1 &&
    stateCode.trim().length >= 2 &&
    postal.trim().length >= 3;

  async function saveBank() {
    setSavingBank(true);
    setError(null);
    try {
      const r = await api<Route>("/api/offramp/bridge/cashout-address", {
        method: "POST",
        body: {
          rail: "ach",
          currency: "usd",
          accountOwnerName: ownerName.trim(),
          accountNumber: accountNumber.trim(),
          routingNumber: routingNumber.trim(),
          checkingOrSavings: acctType,
          street: street.trim(),
          city: city.trim(),
          state: stateCode.trim(),
          postalCode: postal.trim(),
          country: "USA",
        },
      });
      setRoute(r);
      setStep("cashout");
    } catch (e) {
      if (e instanceof ApiError && (e.code === "KYC_NOT_APPROVED" || e.code === "NO_BRIDGE_CUSTOMER")) {
        setStep("kyc");
      } else {
        setError(e instanceof ApiError ? e.message : "Check your details and try again.");
      }
    } finally {
      setSavingBank(false);
    }
  }

  // ── swap USDsui → USDC ──
  const swapNum = Number(swapAmt) || 0;
  const canSwap = swapNum > 0 && swapNum <= usdsuiBal && !swapping;

  async function doSwap() {
    setSwapping(true);
    setError(null);
    try {
      const r = await api<SwapResp>("/api/offramp/bridge/swap-to-usdc-prepare", {
        method: "POST",
        body: { amountUsdsui: swapNum },
      });
      await signAndSubmitPreparedBytes(r.bytes);
      const got = microsToUsdc(r.estimatedUsdcMicros);
      toast(got > 0 ? `Swapped ~${usd(got)} to USDC.` : "Swapped to USDC.", "success");
      setSwapAmt("");
      const fresh = await probeRoute();
      if (fresh) setRoute(fresh);
      refreshBalances();
    } catch (e) {
      if (e instanceof ApiError && e.code === "USD_WITHDRAWAL_CLOSED") {
        setClosedMsg(e.message);
        setStep("closed");
      } else if (e instanceof ApiError && (e.code === "KYC_NOT_APPROVED" || e.code === "NO_BRIDGE_CUSTOMER")) {
        setStep("kyc");
      } else {
        setError(e instanceof ApiError ? e.message : "Swap failed. Try again.");
      }
    } finally {
      setSwapping(false);
    }
  }

  // ── withdraw USDC → bank ──
  const sendNum = Number(sendAmt) || 0;
  const canSend = sendNum >= 1 && sendNum <= pocket + 1e-9 && !sending;

  async function doSend() {
    setSending(true);
    setError(null);
    try {
      const r = await api<SendResp>("/api/offramp/bridge/send-usdc-prepare", {
        method: "POST",
        body: { amountUsdc: sendNum, currency: "usd" },
      });
      await signAndSubmitPreparedBytes(r.bytes);
      setSentAmount(sendNum);
      setStep("result");
    } catch (e) {
      if (e instanceof ApiError && e.code === "INSUFFICIENT_USDC") setError("Swap USDsui to USDC first.");
      else if (e instanceof ApiError && e.code === "BELOW_BRIDGE_MIN") setError("Minimum withdrawal is $1.00.");
      else if (e instanceof ApiError && e.code === "NO_ROUTE") setStep("bankSetup");
      else if (e instanceof ApiError && e.code === "USD_WITHDRAWAL_CLOSED") { setClosedMsg(e.message); setStep("closed"); }
      else if (e instanceof ApiError && (e.code === "KYC_NOT_APPROVED" || e.code === "NO_BRIDGE_CUSTOMER")) setStep("kyc");
      else setError(e instanceof ApiError ? e.message : "Withdrawal failed. Try again.");
    } finally {
      setSending(false);
    }
  }

  const bankLabel = route?.bankName
    ? `${route.bankName}${route.accountLast4 ? ` ••${route.accountLast4}` : ""}`
    : "your US bank";

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 pb-16 pt-2">
      <div className="space-y-3">
        <BackButton href="/app/ramps" label="Ramps" />
        <div>
          <Eyebrow>Cash out · United States</Eyebrow>
          <h1
            className="mt-1 text-[clamp(24px,4.5vw,34px)] font-[500] leading-[1.05] tracking-[-0.05em] text-[#15300c]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
          >
            Cash out to your US bank
          </h1>
        </div>
      </div>

      {step === "loading" && (
        <div className="flex min-h-[220px] items-center justify-center">
          <Spinner size={22} />
        </div>
      )}

      {step === "closed" && (
        <div className={cardCls} style={cardStyle}>
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-[#FFE59E] text-[#15300c]">
              <HugeiconsIcon icon={Alert02Icon} size={24} strokeWidth={2} />
            </span>
            <p className="max-w-sm text-[14px] leading-relaxed text-[#3a5230]">{closedMsg}</p>
            <PrimaryButton full onClick={() => router.push("/app/ramps")}>Back to ramps</PrimaryButton>
          </div>
        </div>
      )}

      {step === "kyc" && (
        <div className={cardCls} style={cardStyle}>
          <KycFlow onApproved={() => init()} />
        </div>
      )}

      {step === "bankSetup" && (
        <div className={cardCls} style={cardStyle}>
          <div className="space-y-4">
            <p className="text-[13.5px] leading-relaxed text-[#3a5230]">
              Add the US bank account to pay out to. You only do this once.
            </p>
            <Field label="Account holder name">
              <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Jane Doe" className={inputCls} />
            </Field>
            <Field label="Account number">
              <input
                inputMode="numeric"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/[^\d]/g, "").slice(0, 17))}
                placeholder="000123456789"
                className={inputCls}
              />
            </Field>
            <Field label="Routing number">
              <input
                inputMode="numeric"
                value={routingNumber}
                onChange={(e) => setRoutingNumber(e.target.value.replace(/[^\d]/g, "").slice(0, 9))}
                placeholder="021000021"
                className={inputCls}
              />
            </Field>
            <div className="flex gap-2">
              {(["checking", "savings"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAcctType(t)}
                  className={`flex-1 rounded-xl border px-4 py-2.5 text-[14px] font-medium capitalize transition-colors ${
                    acctType === t
                      ? "border-[#15300c] bg-[#15300c] text-[#f7fcf2]"
                      : "border-[#15300c]/15 bg-white/60 text-[#3a5230]"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <Field label="Street address">
              <input value={street} onChange={(e) => setStreet(e.target.value)} placeholder="123 Main St" className={inputCls} />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <Field label="City">
                  <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="New York" className={inputCls} />
                </Field>
              </div>
              <Field label="State">
                <input
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="NY"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="ZIP code">
              <input
                inputMode="numeric"
                value={postal}
                onChange={(e) => setPostal(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
                placeholder="10001"
                className={inputCls}
              />
            </Field>
            {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}
            <PrimaryButton full onClick={saveBank} disabled={!canSaveBank || savingBank} loading={savingBank}>
              Save bank
            </PrimaryButton>
          </div>
        </div>
      )}

      {step === "cashout" && (
        <div className="space-y-5">
          {/* USDC pocket — the payout asset, shown prominently. */}
          <div className={cardCls} style={cardStyle}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-[#3d7a29]">
                  USDC pocket
                </span>
                <div className="mt-1 text-[32px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#15300c]">
                  {usd(pocket)}
                </div>
                <div className="mt-1.5 text-[12.5px] text-[#3d7a29]">USDC ready to withdraw to your bank</div>
              </div>
              <UsdcMark className="size-11 shrink-0" />
            </div>
            <p className="mt-4 border-t border-[#15300c]/10 pt-3 text-[12.5px] leading-relaxed text-[#3d7a29]">
              US bank payouts settle in <span className="font-medium text-[#15300c]">USDC</span>. Swap your USDsui
              to USDC (step 1), then withdraw the USDC to your bank (step 2).
            </p>
          </div>

          {/* Step 1 — swap USDsui → USDC */}
          <div className={cardCls} style={cardStyle}>
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-[#3d7a29]">
              Step 1 · Swap USDsui → USDC
            </span>
            <label className="mt-4 block">
              <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29]">
                Amount to swap (USDsui)
              </span>
              <input
                inputMode="decimal"
                value={swapAmt}
                onChange={(e) => setSwapAmt(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
                className={inputCls + " text-[18px]"}
              />
              <span className="mt-1.5 block text-[12px] text-[#3d7a29]">
                Balance: {usd(usdsuiBal)} USDsui · fee-free swap
              </span>
            </label>
            <div className="mt-4">
              <PrimaryButton full onClick={doSwap} disabled={!canSwap} loading={swapping}>
                Swap to USDC
              </PrimaryButton>
            </div>
          </div>

          {/* Step 2 — withdraw USDC → bank */}
          <div className={cardCls} style={cardStyle}>
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
                <HugeiconsIcon icon={BankIcon} size={18} strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <span className="block font-mono text-[11px] uppercase tracking-[0.24em] text-[#3d7a29]">
                  Step 2 · Withdraw USDC to
                </span>
                <div className="truncate text-[15px] font-medium text-[#15300c]">{bankLabel}</div>
              </div>
            </div>
            <label className="mt-4 block">
              <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29]">
                Amount (USDC, min $1.00)
              </span>
              <input
                inputMode="decimal"
                value={sendAmt}
                onChange={(e) => setSendAmt(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
                className={inputCls + " text-[18px]"}
              />
              <span className="mt-1.5 block text-[12px] text-[#3d7a29]">Available: {usd(pocket)} USDC</span>
            </label>
            <div className="mt-4">
              <PrimaryButton full onClick={doSend} disabled={!canSend} loading={sending}>
                Withdraw to bank
              </PrimaryButton>
            </div>
            <p className="mt-3 text-center text-[12px] text-[#3d7a29]">
              Paid out by wire, typically arrives within a business day.
            </p>
          </div>

          {error && <p className="text-center text-[13px] text-[#c0532f]">{error}</p>}
        </div>
      )}

      {step === "result" && (
        <div className={cardCls} style={cardStyle}>
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={24} strokeWidth={2} />
            </span>
            <div>
              <h3 className="text-[18px] font-medium tracking-[-0.05em] text-[#15300c]">Withdrawal on its way</h3>
              <p className="mt-1 max-w-sm text-[14px] leading-relaxed text-[#3a5230]">
                {usd(sentAmount)} was sent for payout to {bankLabel}. The wire typically arrives within a business day.
              </p>
            </div>
            <PrimaryButton full onClick={() => router.push("/app/ramps")}>Done</PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

/** Authentic USDC (Circle) logo, inlined so it always renders (no CDN/CSP). */
function UsdcMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 2000 2000" className={className} role="img" aria-label="USDC">
      <path
        d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
        fill="#2775CA"
      />
      <path
        d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83V541.67c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v95.83c0 16.67 12.5 29.17 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-95.83c125-20.84 208.33-108.34 208.33-220.84z"
        fill="#fff"
      />
      <path
        d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
        fill="#fff"
      />
    </svg>
  );
}

export default CashOutUs;
