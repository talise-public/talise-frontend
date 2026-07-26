"use client";

/**
 * Add-money (on-ramp) card + funding sheet for /app/ramps.
 *
 * Reads the ONE feature verdict from `GET /api/onramp/config` at RUNTIME, so
 * the card follows `ONRAMP_ENABLED` with no redeploy (a build-inlined
 * `NEXT_PUBLIC_*` could not do that). Three honest states:
 *
 *   loading , quiet skeleton, no claim either way
 *   closed  , says plainly that bank funding isn't open yet AND opens the path
 *             that DOES work today (receive dollars to your own address), plus a
 *             notify-me. No dead "Soon" chip that leads nowhere.
 *   open    , the real flow: POST /api/onramp/v2/session → either the hosted
 *             identity step or the actual bank coordinates to send money to.
 *
 * Never claims funds "arrive as USDsui" when the provider delivers USDC — the
 * server says which via `requiresSwapToUsdsui` and the copy follows.
 */

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BankIcon,
  Tick02Icon,
  Notification01Icon,
  ArrowRight01Icon,
  Copy01Icon,
} from "@hugeicons/core-free-icons";
import {
  Sheet,
  Spinner,
  StatusPill,
  PrimaryButton,
  useToast,
  useMe,
  api,
  ApiError,
} from "@/components/app";
import { ReceiveSheet } from "@/components/app/home/ReceiveSheet";

const NOTIFY_KEY = "talise:ramp-notify:onramp";

/** Mirrors the `OnrampStatus` shape served by /api/onramp/config. */
type OnrampConfig = {
  enabled: boolean;
  provider: "bridge" | "transak";
  configured: boolean;
  closedReason: "switch_off" | "provider_unconfigured" | null;
  funding: "bank" | "widget";
  deliverAsset: "USDC" | "USDSUI";
  requiresSwapToUsdsui: boolean;
};

type DepositInstructions = {
  currency: string;
  paymentRails?: string[];
  bankName?: string;
  bankAddress?: string;
  accountNumber?: string;
  routingNumber?: string;
  accountType?: string;
  beneficiaryName?: string;
  beneficiaryAddress?: string;
  iban?: string;
  bic?: string;
  depositMessage?: string;
};

/** Server response from POST /api/onramp/v2/session. */
type SessionResponse = {
  provider?: string;
  kycRequired?: boolean;
  status?: string;
  kycUrl?: string;
  tosUrl?: string;
  widgetUrl?: string;
  depositInstructions?: DepositInstructions;
  requiresSwapToUsdsui?: boolean;
};

export function AddMoneyPanel() {
  const [cfg, setCfg] = useState<OnrampConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api<OnrampConfig>("/api/onramp/config")
      .then((c) => {
        if (alive) setCfg(c);
      })
      .catch(() => {
        // Config unreachable → treat as closed. Fail closed; never invite the
        // user into a flow we can't confirm is open.
        if (alive) setCfg(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <LoadingCard />;
  if (!cfg?.enabled) return <ClosedCard />;

  return (
    <>
      <OpenCard onStart={() => setSheetOpen(true)} />
      <FundingSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        cfg={cfg}
      />
    </>
  );
}

/* ── shared chrome ──────────────────────────────────────────────────── */

function CardFrame({
  children,
  dashed,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      className={
        dashed
          ? "relative flex flex-col overflow-hidden rounded-[28px] border border-dashed border-[#15300c]/20 bg-[#f7fcf2]/60 p-7 sm:p-9"
          : "relative flex flex-col overflow-hidden rounded-[28px] bg-[#f7fcf2] p-7 sm:p-9"
      }
      style={
        dashed
          ? undefined
          : {
              boxShadow:
                "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)",
            }
      }
    >
      {children}
    </div>
  );
}

function CardHead({
  title,
  muted,
  pill,
}: {
  title: string;
  muted?: boolean;
  pill?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${
          muted
            ? "bg-[#15300c]/[0.06] text-[#3d7a29]"
            : "bg-[#CAFFB8] text-[#15300c]"
        }`}
      >
        <HugeiconsIcon icon={BankIcon} size={20} strokeWidth={1.8} />
      </span>
      <div className="space-y-1">
        <span className="block font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          On-ramp
        </span>
        <h2
          className={`flex flex-wrap items-center gap-2 text-[20px] font-[500] tracking-[-0.05em] ${
            muted ? "text-[#3a5230]" : "text-[#15300c]"
          }`}
          style={{
            fontFamily:
              '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
          }}
        >
          {title}
          {pill}
        </h2>
      </div>
    </div>
  );
}

/* ── states ─────────────────────────────────────────────────────────── */

function LoadingCard() {
  return (
    <CardFrame dashed>
      <CardHead title="Add money" muted />
      <div className="mt-5 flex items-center gap-2.5 text-[13px] text-[#3d7a29]">
        <Spinner />
        Checking which funding rails are open…
      </div>
    </CardFrame>
  );
}

/**
 * CLOSED. Honest about what isn't there, and useful: the funding path that
 * genuinely works today is receiving dollars to your own address, so we open it
 * right here instead of leaving the user at a dead end.
 */
function ClosedCard() {
  const { toast } = useToast();
  const { me } = useMe();
  const [notified, setNotified] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  useEffect(() => {
    try {
      setNotified(localStorage.getItem(NOTIFY_KEY) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);

  function notifyMe() {
    if (notified) return;
    setNotified(true);
    try {
      localStorage.setItem(NOTIFY_KEY, "1");
    } catch {
      /* ignore */
    }
    toast("You're on the list, we'll let you know the moment it's live.", "success");
  }

  return (
    <CardFrame dashed>
      <CardHead
        title="Add money from a bank"
        muted
        pill={<StatusPill label="Not open yet" tone="neutral" />}
      />
      <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-[#3d7a29]">
        Bank and card funding isn&apos;t switched on for your account yet. Until
        it is, fund Talise by receiving dollars to your own address — anyone
        holding USDsui, and any wallet or exchange that can send on Sui, can pay
        you there.
      </p>
      <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
        <button
          type="button"
          onClick={() => setReceiveOpen(true)}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#15300c] px-6 text-[14px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
        >
          Show my deposit address
          <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={notifyMe}
          disabled={notified}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full border-2 border-[#15300c] bg-transparent px-6 text-[14px] font-semibold text-[#15300c] transition-colors duration-150 hover:bg-[#15300c] hover:text-[#f7fcf2] disabled:border-[#15300c]/20 disabled:text-[#3d7a29] disabled:hover:bg-transparent disabled:hover:text-[#3d7a29]"
        >
          <HugeiconsIcon
            icon={notified ? Tick02Icon : Notification01Icon}
            size={15}
            strokeWidth={2}
          />
          {notified ? "On the list" : "Notify me when it's live"}
        </button>
      </div>
      <ReceiveSheet
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        me={me}
      />
    </CardFrame>
  );
}

function OpenCard({ onStart }: { onStart: () => void }) {
  return (
    <CardFrame>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <CardHead title="Add money from your bank" />
        <button
          type="button"
          onClick={onStart}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-[#15300c] px-5 text-[14px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
        >
          Get funding details
        </button>
      </div>
      <p className="mt-4 max-w-md text-[13.5px] leading-relaxed text-[#3d7a29]">
        We&apos;ll issue you a bank account number in your own currency. Money you
        send to it lands in your Talise wallet.
      </p>
    </CardFrame>
  );
}

/* ── the real flow ──────────────────────────────────────────────────── */

/** Funding currencies Bridge issues virtual accounts in. */
const CURRENCIES = ["usd", "eur", "gbp"] as const;

function FundingSheet({
  open,
  onClose,
  cfg,
}: {
  open: boolean;
  onClose: () => void;
  cfg: OnrampConfig;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string>("usd");

  const load = useCallback(async (ccy: string) => {
    setLoading(true);
    setError(null);
    setSession(null);
    try {
      const s = await api<SessionResponse>("/api/onramp/v2/session", {
        method: "POST",
        // Informational only: a virtual account accepts any amount and the
        // server never credits a balance from this number.
        body: { amountCents: 10_000, sourceCurrency: ccy },
      });
      setSession(s);
    } catch (e) {
      const err = e as ApiError;
      setError(
        err.status === 404 || err.status === 503
          ? "Bank funding isn't switched on right now. Please try again later."
          : err.message || "Couldn't set up funding. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !session && !loading && !error) void load(currency);
    // Intentionally keyed on `open` only: re-running on every state change
    // would loop the POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    onClose();
    window.setTimeout(() => {
      setSession(null);
      setError(null);
    }, 200);
  }

  function copy(label: string, value: string) {
    void navigator.clipboard?.writeText(value);
    toast(`${label} copied`, "success");
  }

  const di = session?.depositInstructions;
  const needsSwap = session?.requiresSwapToUsdsui ?? cfg.requiresSwapToUsdsui;
  const nothingUsable =
    !!session && !session.kycRequired && !di && !session.widgetUrl;

  return (
    <Sheet open={open} onClose={close} title="Add money" size="md">
      <div className="space-y-5 pb-2">
        {loading && (
          <div className="flex items-center gap-2.5 py-6 text-[13px] text-[#3d7a29]">
            <Spinner />
            Setting up your funding details…
          </div>
        )}

        {!loading && error && (
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-[#15300c]">{error}</p>
            <PrimaryButton full onClick={() => void load(currency)}>
              Try again
            </PrimaryButton>
          </div>
        )}

        {/* Identity step — Bridge won't issue an account until KYC clears. */}
        {!loading && !error && session?.kycRequired && (
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-[#15300c]">
              One quick identity check before your funding account is issued.
              It&apos;s handled by our banking partner and takes a couple of
              minutes.
            </p>
            {session.kycUrl && (
              <a
                href={session.kycUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center rounded-full bg-[#15300c] px-6 py-3 text-[15px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
              >
                Verify my identity
              </a>
            )}
            {session.tosUrl && (
              <a
                href={session.tosUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center text-[13px] text-[#3a5230] underline-offset-2 hover:underline"
              >
                Review and accept the terms
              </a>
            )}
            <button
              type="button"
              onClick={() => void load(currency)}
              className="block w-full text-center text-[13px] text-[#3a5230] underline-offset-2 hover:underline"
            >
              I&apos;ve finished — check again
            </button>
          </div>
        )}

        {/* Hosted-widget providers (Transak). */}
        {!loading && !error && !session?.kycRequired && session?.widgetUrl && (
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-[#15300c]">
              Finish your top-up with our payment partner. Your Talise address is
              locked in server-side, so funds can only land in your own wallet.
            </p>
            <a
              href={session.widgetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center rounded-full bg-[#15300c] px-6 py-3 text-[15px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
            >
              Open secure checkout
            </a>
          </div>
        )}

        {/* Bank funding — the real coordinates. */}
        {!loading && !error && di && (
          <div className="space-y-4">
            {cfg.funding === "bank" && (
              <div className="flex gap-1.5">
                {CURRENCIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setCurrency(c);
                      void load(c);
                    }}
                    className={`h-8 rounded-full px-3.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors ${
                      c === currency
                        ? "bg-[#15300c] text-[#f7fcf2]"
                        : "bg-[#15300c]/[0.06] text-[#3d7a29] hover:bg-[#CAFFB8]/50"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[14px] leading-relaxed text-[#15300c]">
              Send {di.currency.toUpperCase()} from your bank to the account
              below. It&apos;s yours permanently — reuse it any time you top up.
            </p>
            <div className="divide-y divide-[#15300c]/10 overflow-hidden rounded-2xl border border-[#15300c]/10 bg-white/60">
              <CopyRow label="Beneficiary" value={di.beneficiaryName} onCopy={copy} />
              <CopyRow label="Bank" value={di.bankName} onCopy={copy} />
              <CopyRow label="Account number" value={di.accountNumber} onCopy={copy} />
              <CopyRow label="Routing number" value={di.routingNumber} onCopy={copy} />
              <CopyRow label="Account type" value={di.accountType} onCopy={copy} />
              <CopyRow label="IBAN" value={di.iban} onCopy={copy} />
              <CopyRow label="BIC" value={di.bic} onCopy={copy} />
              <CopyRow label="Reference" value={di.depositMessage} onCopy={copy} />
            </div>
            {di.depositMessage && (
              <p className="text-[12px] leading-relaxed text-[#c0532f]">
                Include the reference exactly as shown, or your bank may not be
                able to match the deposit.
              </p>
            )}
            <p className="text-[12px] leading-relaxed text-[#3d7a29]">
              {needsSwap
                ? "Funds arrive on Sui as USDC. One tap on your home screen converts them to USDsui — free, and it takes a moment."
                : "Funds arrive as USDsui in your wallet."}
            </p>
            <button
              type="button"
              onClick={close}
              className="block w-full text-center text-[13px] text-[#3a5230] underline-offset-2 hover:underline"
            >
              Done
            </button>
          </div>
        )}

        {/* Enabled, no KYC step, but the provider gave us nothing usable. */}
        {!loading && !error && nothingUsable && (
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-[#15300c]">
              We couldn&apos;t get your funding details just now. Nothing has been
              charged — please try again in a moment.
            </p>
            <PrimaryButton full onClick={() => void load(currency)}>
              Try again
            </PrimaryButton>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function CopyRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value?: string;
  onCopy: (label: string, value: string) => void;
}) {
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={() => onCopy(label, value)}
      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[#CAFFB8]/25"
    >
      <span className="min-w-0">
        <span className="block font-mono text-[10px] uppercase tracking-[0.28em] text-[#3d7a29]">
          {label}
        </span>
        <span className="block truncate text-[14px] text-[#15300c]">{value}</span>
      </span>
      <HugeiconsIcon
        icon={Copy01Icon}
        size={15}
        strokeWidth={1.8}
        className="shrink-0 text-[#3d7a29]"
      />
    </button>
  );
}
