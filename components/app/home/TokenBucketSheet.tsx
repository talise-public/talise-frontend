"use client";

/**
 * Token bucket (web), the web counterpart of iOS TokenBucketView. Lists every
 * token the user holds BESIDES USDsui (the verified, swappable coins from
 * /api/wallet/balances), with its amount + USD value, a total hero, and a
 * one-tap "Swap to USDsui" per coin (POST /api/swap/prepare → sign). Coins
 * outside the swap allowlist surface a friendly "not swappable yet" toast.
 */

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import {
  Sheet,
  EmptyState,
  Spinner,
  api,
  ApiError,
  useToast,
  useCurrency,
} from "@/components/app";
import { signSponsorReadyBytes } from "@/components/app/cheques/signBytes";

type Coin = {
  coinType: string;
  amount: string; // raw base units
  isUsdsui: boolean;
  symbol: string;
  decimals: number;
  logoUrl: string | null;
  usdValue: number | null;
};
type BalancesResp = { address: string; balances: Coin[] };

const humanAmount = (c: Coin): number => {
  const n = Number(c.amount);
  return Number.isFinite(n) ? n / 10 ** (c.decimals ?? 9) : 0;
};
const fmtAmount = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 0 });
const symOf = (c: Coin) => c.symbol || c.coinType.split("::").pop() || "TOKEN";

export function TokenBucketSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [swapping, setSwapping] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<BalancesResp>("/api/wallet/balances");
      setCoins((r.balances ?? []).filter((c) => !c.isUsdsui && Number(c.amount) > 0));
    } catch {
      setCoins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const total = (coins ?? []).reduce((s, c) => s + (c.usdValue ?? 0), 0);

  const swap = async (coin: Coin) => {
    setSwapping(coin.coinType);
    try {
      const prep = await api<{ bytes: string }>("/api/swap/prepare", {
        method: "POST",
        body: { fromCoinType: coin.coinType, fromAmountMicros: coin.amount },
      });
      await signSponsorReadyBytes(prep.bytes, { kind: "swap-to-usdsui" });
      toast(`Swapped ${symOf(coin)} to USDsui`, "success");
      setCoins((cs) => (cs ?? []).filter((c) => c.coinType !== coin.coinType));
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("talise:tx", { detail: { kind: "swap" } }));
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? /unsupported|allowlist/i.test(err.message)
            ? "This token can't be swapped to USDsui yet."
            : err.message
          : "Couldn't swap that token.";
      toast(msg, "danger");
    } finally {
      setSwapping(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Token bucket" size="md">
      {loading && coins === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (coins?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<HugeiconsIcon icon={Coins01Icon} size={24} strokeWidth={1.6} />}
          title="No other tokens yet"
          subtitle="Tokens you hold besides USDsui show up here, swap any of them to USDsui in one tap."
        />
      ) : (
        <div className="space-y-5">
          {/* Total value hero */}
          <div className="text-center">
            <div
              className="text-[40px] font-[800] tabular-nums tracking-[-0.05em] text-[#15300c]"
              style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif' }}
            >
              {formatUsd(total, { fixed: true })}
            </div>
            <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29]">
              Total bucket value
            </div>
          </div>

          {/* Coin rows */}
          <div className="space-y-2.5">
            {coins!.map((coin) => {
              const busy = swapping === coin.coinType;
              const sym = symOf(coin);
              return (
                <div
                  key={coin.coinType}
                  className="flex items-center gap-3 rounded-2xl border border-[#15300c]/10 bg-white/60 p-3.5 backdrop-blur-sm"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#CAFFB8] text-[#15300c]">
                    {coin.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={coin.logoUrl} alt="" className="size-10 rounded-full object-cover" />
                    ) : (
                      <span className="text-[15px] font-semibold">{sym.slice(0, 1)}</span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-[#15300c]">{sym}</div>
                    <div className="truncate font-mono text-[12px] text-[#3d7a29]">
                      {fmtAmount(humanAmount(coin))} {sym}
                      {coin.usdValue != null ? ` · ${formatUsd(coin.usdValue, { fixed: true })}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void swap(coin)}
                    disabled={busy}
                    className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#15300c] px-4 py-2 text-[12px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98] disabled:opacity-60"
                  >
                    {busy ? "Swapping…" : "Swap to USDsui"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Sheet>
  );
}
