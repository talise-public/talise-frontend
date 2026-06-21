"use client";

import { useCallback, useMemo, useState } from "react";
import { Sheet } from "@/components/app/ui/Sheet";
import { PrimaryButton } from "@/components/app/ui/PrimaryButton";
import type { SessionResult } from "@/lib/onramp/types";

/**
 * "Add money" (on-ramp) sheet — Transak hosted checkout.
 *
 * Flow: enter a USD amount → POST /api/onramp/v2/session → open the provider's
 * hosted widget in a new tab. Transak runs the KYC + card/bank payment itself
 * and delivers USDC on the user's Sui address; a follow-up swap converts that
 * USDC → USDsui. We collect NO identity fields here — the widget owns KYC.
 *
 * DORMANT by default: renders nothing unless NEXT_PUBLIC_ONRAMP_ENABLED is
 * "true". It only calls the additive /api/onramp/v2/* routes and never touches
 * the send/balance/limit path.
 */

const ENABLED = process.env.NEXT_PUBLIC_ONRAMP_ENABLED === "true";

export interface AddMoneyModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddMoneyModal({ open, onClose }: AddMoneyModalProps) {
  const [amount, setAmount] = useState("");
  const [session, setSession] = useState<SessionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountCents = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  }, [amount]);

  const reset = useCallback(() => {
    setAmount("");
    setSession(null);
    setError(null);
    setLoading(false);
  }, []);

  const close = useCallback(() => {
    onClose();
    // reset after the close animation so a reopen is fresh
    setTimeout(reset, 200);
  }, [onClose, reset]);

  const start = useCallback(async () => {
    setError(null);
    if (amountCents <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch("/api/onramp/v2/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amountCents }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error ?? "Could not start checkout.");
      const s = json as SessionResult;
      setSession(s);
      // Auto-open the hosted widget (popup-blockers may require the explicit
      // button below as a fallback).
      if (s.widgetUrl && typeof window !== "undefined") {
        window.open(s.widgetUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [amountCents]);

  if (!ENABLED) return null;

  return (
    <Sheet open={open} onClose={close} title="Add money" size="md">
      <div className="space-y-5 pb-2">
        {!session ? (
          <>
            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
                Amount (USD)
              </label>
              <div className="flex items-center gap-2 rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 backdrop-blur-sm">
                <span className="text-[18px] text-[#3a5230]" style={{ fontFamily: "var(--font-display-v2)" }}>$</span>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) =>
                    setAmount(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  placeholder="0.00"
                  className="w-full bg-transparent text-[18px] tabular-nums text-[#15300c] outline-none placeholder:text-[#3d7a29]"
                />
              </div>
            </div>

            <p className="text-[13px] leading-relaxed text-[#3d7a29]">
              You&apos;ll verify your identity and pay by card or bank with our
              partner. Funds arrive as USDsui in your wallet, usually within a
              few minutes.
            </p>

            <PrimaryButton
              full
              loading={loading}
              disabled={loading || amountCents <= 0}
              onClick={start}
            >
              {loading ? "Starting…" : "Continue to secure checkout"}
            </PrimaryButton>
          </>
        ) : (
          /* Session started — widget opened in a new tab. */
          <div className="space-y-4 text-center">
            <p className="text-[15px] leading-relaxed text-[#15300c]">
              Complete your purchase in the checkout tab. Once it clears, your
              balance updates automatically.
            </p>
            {session.widgetUrl && (
              <a
                href={session.widgetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="relative inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#15300c] px-6 py-3 text-[15px] font-semibold text-[#f7fcf2] outline-none transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[#3d7a29]/55 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f7fcf2]"
              >
                Open secure checkout
              </a>
            )}
            {session.requiresSwapToUsdsui && (
              <p className="text-[12px] leading-relaxed text-[#3d7a29]">
                Funds arrive as USDC on Sui and are converted to USDsui for you.
              </p>
            )}
            <button
              type="button"
              onClick={close}
              className="text-[13px] text-[#3a5230] underline-offset-2 hover:underline"
            >
              Done
            </button>
          </div>
        )}

        {error && <p className="text-[12px] text-[#c0532f]">{error}</p>}
      </div>
    </Sheet>
  );
}
