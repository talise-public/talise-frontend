"use client";

/**
 * RequestPanel, the Receive / Request experience for /app/pay/request.
 *
 * Two modes selected by a glass segmented control:
 *
 *   Receive  →  a plain receive QR encoding `sui:<address>` + copy address.
 *               External Sui wallets understand this format too.
 *   Request  →  enter an amount (+ optional memo) and we build a shareable
 *               PAYMENT LINK to `<origin>/pay/<handle>?amount=&memo=` with a QR,
 *               copy, and native share. Falls back to the address when the user
 *               hasn't claimed a Talise handle yet.
 *
 * Mirrors the iOS ReceiveView: handle-first identity, USD-denominated request
 * amount, white-panel QR.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { publicOrigin } from "@/lib/public-origin";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Tick02Icon,
  Share08Icon,
  QrCode01Icon,
  Wallet01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import {
  GlassCard,
  Eyebrow,
  MicroLabel,
  QrImage,
  PrimaryButton,
  useMe,
  useToast,
  useCurrency,
} from "@/components/app";

type Mode = "receive" | "request";

function shortAddr(a: string): string {
  if (!a || a.length <= 16) return a;
  return `${a.slice(0, 10)}…${a.slice(-8)}`;
}

export function RequestPanel() {
  const { me, loading } = useMe();
  const { toast } = useToast();
  const { symbol, toLocal } = useCurrency();

  const [mode, setMode] = useState<Mode>("receive");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [copied, setCopied] = useState<"addr" | "link" | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const address = me?.suiAddress ?? "";
  const handle = me?.taliseHandle ?? null;

  const origin = publicOrigin();

  // Parsed request amount in USD (USDsui is 1:1 USD). The field is entered in
  // USD to match the on-chain settlement currency and the public pay link.
  const amountUsd = useMemo(() => {
    const v = parseFloat(amount);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [amount]);

  // The shareable payment link. Handle-first so the payer sees the @handle;
  // we fall back to the raw address path when no handle is claimed.
  const paymentLink = useMemo(() => {
    const slug = handle ?? address;
    if (!slug) return "";
    const url = new URL(`${origin}/pay/${encodeURIComponent(slug)}`);
    if (amountUsd != null) url.searchParams.set("amount", amountUsd.toFixed(2));
    if (memo.trim()) url.searchParams.set("memo", memo.trim());
    return url.toString();
  }, [handle, address, origin, amountUsd, memo]);

  // What the QR encodes per mode.
  const qrValue = mode === "receive" ? (address ? `sui:${address}` : "") : paymentLink;

  const copy = async (text: string, which: "addr" | "link") => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast(which === "addr" ? "Address copied" : "Payment link copied", "success");
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1600);
    } catch {
      toast("Couldn't copy, try selecting manually", "danger");
    }
  };

  const share = async () => {
    const text = mode === "receive" ? address : paymentLink;
    if (!text) return;
    // Web Share API where available (mobile); otherwise fall back to copy.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: "Pay me on Talise",
          text:
            mode === "request" && amountUsd != null
              ? `Pay ${symbol}${amountUsd.toFixed(2)} on Talise`
              : "Pay me on Talise",
          url: mode === "receive" ? undefined : paymentLink,
        });
        return;
      } catch {
        /* user cancelled or unsupported, fall through to copy */
      }
    }
    await copy(text, mode === "receive" ? "addr" : "link");
  };

  const identity = handle ? `${handle}@talise` : address ? shortAddr(address) : "your wallet";

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      {/* Heading */}
      <div>
        <Eyebrow>Receive</Eyebrow>
        <h1
          className="mt-1 text-[26px] font-[500] tracking-[-0.05em] text-[#15300c]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          Get paid
        </h1>
      </div>

      {/* Mode segmented control */}
      <div className="flex gap-1 rounded-[6px] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1">
        <SegButton active={mode === "receive"} onClick={() => setMode("receive")} icon={QrCode01Icon}>
          Receive
        </SegButton>
        <SegButton active={mode === "request"} onClick={() => setMode("request")} icon={Wallet01Icon}>
          Request
        </SegButton>
      </div>

      {/* Request inputs */}
      {mode === "request" && (
        <GlassCard className="divide-y divide-[#15300c]/10 p-0" radius={28}>
          {/* Amount */}
          <div className="px-5 py-4">
            <label className="block font-mono text-[10px] font-medium uppercase text-[#3d7a29]" style={{ letterSpacing: "0.2em" }}>
              Amount (optional)
            </label>
            <p className="mt-0.5 font-mono text-[10px] text-[#3d7a29]">Leave blank for an open request.</p>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-[22px] text-[#3a5230]" style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>$</span>
              <input
                value={amount}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
                }}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full bg-transparent text-[28px] font-[800] text-[#15300c] tabular-nums outline-none placeholder:text-[#3d7a29]"
                style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', letterSpacing: "-0.02em" }}
              />
              {amount && (
                <button
                  type="button"
                  onClick={() => setAmount("")}
                  aria-label="Clear amount"
                  className="flex size-7 items-center justify-center rounded-full border border-[#15300c]/15 bg-white/60 text-[#3d7a29] backdrop-blur-sm hover:text-[#15300c]"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>

          {/* Memo */}
          <div className="px-5 py-4">
            <label className="block font-mono text-[10px] font-medium uppercase text-[#3d7a29]" style={{ letterSpacing: "0.2em" }}>
              Memo (optional)
            </label>
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value.slice(0, 80))}
              placeholder="What's it for?"
              className="mt-2 w-full bg-transparent text-[15px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
            />
          </div>
        </GlassCard>
      )}

      {/* QR card */}
      <GlassCard radius={28} className="flex flex-col items-center px-6 py-6 text-center">
        <span
          className="text-[17px] font-[800] text-[#15300c]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', letterSpacing: "-0.05em" }}
        >
          {loading ? "-" : identity}
        </span>

        {mode === "request" && amountUsd != null && (
          <span className="mt-2 text-[15px] font-[800] tabular-nums text-[#3d7a29]" style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', letterSpacing: "-0.02em" }}>
            Requesting {symbol}
            {toLocal(amountUsd).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        )}
        {mode === "request" && memo.trim() && (
          <span className="mt-1 max-w-[16rem] truncate text-[13px] text-[#3d7a29]">
            &ldquo;{memo.trim()}&rdquo;
          </span>
        )}

        <div className="mt-5">
          {qrValue ? (
            <QrImage value={qrValue} size={200} />
          ) : (
            <div className="size-[200px] animate-pulse rounded-2xl bg-[#CAFFB8]/40" />
          )}
        </div>

        <MicroLabel className="mt-4 block max-w-full truncate">{shortAddr(address)}</MicroLabel>
      </GlassCard>

      {/* Actions */}
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={() =>
            mode === "receive" ? copy(address, "addr") : copy(paymentLink, "link")
          }
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-[6px] border border-[#15300c] px-5 py-3 text-[12px] uppercase tracking-[0.06em] font-mono text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={16}
            strokeWidth={2}
            color={copied ? "#3d7a29" : undefined}
          />
          {copied ? "Copied" : mode === "receive" ? "Copy address" : "Copy link"}
        </button>
        <div className="flex-1">
          <PrimaryButton full onClick={share}>
            <HugeiconsIcon icon={Share08Icon} size={15} strokeWidth={2} color="#f7fcf2" />
            {mode === "receive" ? "Share" : "Share request"}
          </PrimaryButton>
        </div>
      </div>

      {!handle && mode === "request" && (
        <p className="text-center text-[12px] text-[#3d7a29]">
          Claim a Talise handle in Settings for a cleaner link like{" "}
          <span className="text-[#3a5230]">talise.io/pay/you</span>.
        </p>
      )}
    </div>
  );
}

// ── Segmented control button ────────────────────────────────────────────────────

function SegButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-2 rounded-[3px] py-2 text-[12px] font-mono transition-colors ${
        active ? "bg-[#CAFFB8] text-[#15300c]" : "text-[#2f6a1f] hover:text-[#15300c]"
      }`}
    >
      <HugeiconsIcon
        icon={icon}
        size={16}
        strokeWidth={1.9}
        color={active ? "#15300c" : "#3d7a29"}
      />
      {children}
    </button>
  );
}

export default RequestPanel;
