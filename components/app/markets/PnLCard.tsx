"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon } from "@hugeicons/core-free-icons";
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
const CARD_FONT = '"Google Sans Variable", "Google Sans", system-ui, sans-serif';

const loadImg = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

/**
 * Shareable PnL card — a happy green anime scene for profit, a somber red one
 * for a loss (art via Higgsfield), with the trade stats blended cleanly on top.
 * Download composites the WHOLE card (art + scrim + stats) onto a canvas, not
 * just the raw background image.
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

  // Composite the full card (art + scrim + overlaid stats) at 3× and download it.
  const download = async () => {
    try {
      const W = 360, H = 480, SC = 3;
      const cv = document.createElement("canvas");
      cv.width = W * SC; cv.height = H * SC;
      const c = cv.getContext("2d"); if (!c) return;
      c.scale(SC, SC);
      try { await document.fonts.ready; } catch { /* */ }

      roundRect(c, 0, 0, W, H, 28); c.clip();

      // background (cover-fit) + scrim
      const bg = await loadImg(win ? "/pnl/win.png" : "/pnl/loss.png");
      const ar = bg.width / bg.height, car = W / H;
      let dw = W, dh = H, dx = 0, dy = 0;
      if (ar > car) { dh = H; dw = H * ar; dx = (W - dw) / 2; } else { dw = W; dh = W / ar; dy = (H - dh) / 2; }
      c.drawImage(bg, dx, dy, dw, dh);
      const g = c.createLinearGradient(0, 0, 0, H);
      const stops: [number, string][] = win
        ? [[0, "rgba(4,16,3,0.55)"], [0.3, "rgba(4,16,3,0.05)"], [0.62, "rgba(4,16,3,0.35)"], [1, "rgba(4,16,3,0.9)"]]
        : [[0, "rgba(18,3,6,0.6)"], [0.3, "rgba(18,3,6,0.05)"], [0.62, "rgba(18,3,6,0.4)"], [1, "rgba(18,3,6,0.92)"]];
      for (const [o, col] of stops) g.addColorStop(o, col);
      c.fillStyle = g; c.fillRect(0, 0, W, H);

      c.textAlign = "left"; c.textBaseline = "alphabetic";
      // brand
      try { const logo = await loadImg("/logo.png"); c.save(); c.filter = "invert(1) brightness(1.6)"; c.drawImage(logo, 20, 20, 20, 20); c.restore(); } catch { /* */ }
      c.fillStyle = "#fff"; c.font = `700 15px ${CARD_FONT}`; c.fillText("talise", 46, 35);
      const tw = c.measureText("talise").width;
      c.font = `600 9.5px ${CARD_FONT}`; const pw = c.measureText("PERPS").width, px = 46 + tw + 8;
      c.fillStyle = "rgba(255,255,255,0.16)"; roundRect(c, px, 24, pw + 14, 15, 7); c.fill();
      c.fillStyle = "#fff"; c.fillText("PERPS", px + 7, 35);

      // asset + side
      try { const ic = await loadImg(`/api/asset-icon/${data.ticker.toUpperCase()}`); c.save(); roundRect(c, 20, 250, 26, 26, 13); c.clip(); c.drawImage(ic, 20, 250, 26, 26); c.restore(); } catch { /* */ }
      c.fillStyle = "#fff"; c.font = `600 16px ${CARD_FONT}`; c.fillText(`${m.sym}/USD`, 54, 268);
      const sw = c.measureText(`${m.sym}/USD`).width;
      const badge = `${data.isLong ? "LONG" : "SHORT"}${data.leverage ? ` ${data.leverage.toFixed(0)}x` : ""}`;
      c.font = `700 11px ${CARD_FONT}`; const bw = c.measureText(badge).width, bx = 54 + sw + 8;
      c.fillStyle = win ? "rgba(47,158,68,0.5)" : "rgba(224,87,79,0.5)"; roundRect(c, bx, 255, bw + 12, 17, 5); c.fill();
      c.fillStyle = "#fff"; c.fillText(badge, bx + 6, 268);

      // pnl
      c.fillStyle = accent; c.font = `800 58px ${CARD_FONT}`; c.fillText(`${data.pnlPct >= 0 ? "+" : ""}${data.pnlPct.toFixed(1)}%`, 20, 350);
      c.fillStyle = "#fff"; c.font = `700 20px ${CARD_FONT}`; c.fillText(`${win ? "+" : "-"}$${Math.abs(data.pnlUsd).toFixed(2)}`, 20, 378);

      // footer
      c.font = `400 12px ${CARD_FONT}`; c.fillStyle = "rgba(255,255,255,0.7)"; c.fillText("Entry", 20, 420); c.fillText("Mark", 120, 420);
      c.fillStyle = "#fff"; c.font = `600 12px ${CARD_FONT}`; c.fillText(`$${fmtP(data.entryPriceUsd)}`, 20, 436); c.fillText(`$${fmtP(data.markPriceUsd)}`, 120, 436);
      c.font = `400 10.5px ${CARD_FONT}`; c.fillStyle = "rgba(255,255,255,0.72)"; c.textAlign = "center"; c.fillText("talise.io · gasless perps on Sui", W / 2, 462);

      const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = `talise-pnl-${m.sym.toLowerCase()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch { /* */ }
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
              <button onClick={download} aria-label="Download PnL card" className="flex items-center justify-center rounded-xl bg-white/15 px-3.5 py-2.5 text-white backdrop-blur-sm">
                <HugeiconsIcon icon={Download04Icon} size={18} />
              </button>
            </div>
            <div className="mt-2 text-center text-[10.5px] opacity-70">talise.io · gasless perps on Sui</div>
          </div>
        </div>
      </div>
    </div>
  );
}
