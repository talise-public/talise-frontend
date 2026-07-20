"use client";

import { AssetIcon } from "@/components/app/markets/AssetIcon";
import { assetMeta } from "@/lib/waterx-assets";

export type PnLCardData = {
  ticker: string;
  isLong: boolean;
  leverage: number;
  entryPriceUsd: number;
  markPriceUsd: number;
  pnlUsd: number;
  pnlPct: number;
};

const fmtP = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toFixed(4));

/**
 * Shareable PnL card, a happy green anime scene for profit, a somber red one
 * for a loss (art via Higgsfield), with the trade stats blended cleanly on top.
 */
export function PnLCard({ data, onClose }: { data: PnLCardData; onClose: () => void }) {
  const win = data.pnlUsd >= 0;
  const m = assetMeta(data.ticker);
  const scrim = win
    ? "linear-gradient(180deg, rgba(4,16,3,0.55) 0%, rgba(4,16,3,0.05) 30%, rgba(4,16,3,0.35) 62%, rgba(4,16,3,0.9) 100%)"
    : "linear-gradient(180deg, rgba(18,3,6,0.6) 0%, rgba(18,3,6,0.05) 30%, rgba(18,3,6,0.4) 62%, rgba(18,3,6,0.92) 100%)";
  const accent = win ? "#8bffa8" : "#ff9a9a";

  const share = async () => {
    const text = `${win ? "📈" : "📉"} ${data.isLong ? "Long" : "Short"} ${m.sym} · ${win ? "+" : ""}${data.pnlPct.toFixed(1)}% (${win ? "+" : "-"}$${Math.abs(data.pnlUsd).toFixed(2)}) on Talise perps`;
    try {
      if (navigator.share) await navigator.share({ text, url: "https://talise.io" });
      else { await navigator.clipboard.writeText(`${text}, https://talise.io`); }
    } catch { /* cancelled */ }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div className="relative overflow-hidden rounded-[28px] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)]" style={{ width: 360, maxWidth: "92vw", aspectRatio: "3 / 4" }} onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={win ? "/pnl/win.png" : "/pnl/loss.png"} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0" style={{ background: scrim }} />

        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm">✕</button>

        <div className="relative flex h-full flex-col justify-between p-5 text-white">
          {/* brand */}
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 20, height: 20, filter: "invert(1) brightness(1.5)" }} />
            <span className="text-[15px] font-bold tracking-tight">talise</span>
            <span className="ml-1 rounded-full bg-white/15 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] backdrop-blur-sm">Perps</span>
          </div>

          {/* pnl */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <AssetIcon ticker={data.ticker} size={26} />
              <span className="text-[16px] font-semibold">{m.sym}/USD</span>
              <span className="rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: win ? "rgba(47,158,68,0.35)" : "rgba(224,87,79,0.35)", color: "#fff" }}>
                {data.isLong ? "LONG" : "SHORT"} {data.leverage ? `${data.leverage.toFixed(0)}x` : ""}
              </span>
            </div>
            <div className="text-[58px] font-[800] leading-none tracking-tight" style={{ color: accent, textShadow: "0 2px 20px rgba(0,0,0,0.4)" }}>
              {data.pnlPct >= 0 ? "+" : ""}{data.pnlPct.toFixed(1)}%
            </div>
            <div className="mt-1 text-[20px] font-bold" style={{ textShadow: "0 2px 12px rgba(0,0,0,0.5)" }}>
              {win ? "+" : "-"}${Math.abs(data.pnlUsd).toFixed(2)}
            </div>
          </div>

          {/* footer */}
          <div>
            <div className="flex gap-6 text-[12px]">
              <div><div className="opacity-70">Entry</div><div className="font-semibold tabular-nums">${fmtP(data.entryPriceUsd)}</div></div>
              <div><div className="opacity-70">Mark</div><div className="font-semibold tabular-nums">${fmtP(data.markPriceUsd)}</div></div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button onClick={share} className="flex-1 rounded-xl bg-white/90 py-2.5 text-[14px] font-bold text-[#15300c]">Share</button>
              <a href={win ? "/pnl/win.png" : "/pnl/loss.png"} download className="rounded-xl bg-white/15 px-3 py-2.5 text-[13px] font-semibold text-white backdrop-blur-sm">↓</a>
            </div>
            <div className="mt-2 text-center text-[10.5px] opacity-70">talise.io · gasless perps on Sui</div>
          </div>
        </div>
      </div>
    </div>
  );
}
