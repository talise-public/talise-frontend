"use client";

/**
 * TradeChart, TradingView lightweight-charts candlesticks for the perps
 * terminal. Candles are proxied from Binance spot via /api/markets/candles
 * (WaterX drives the on-chain perp state; price history mirrors the deep spot
 * market of the same asset). Chart instance persists across symbol/interval
 * changes; data is refreshed on change and polled live.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Time } from "lightweight-charts";

type Candle = { time: number; open: number; high: number; low: number; close: number };

// Readable price: thousands separators + up to 4 decimals (min 2). Renders
// BTC as "66,172.90" and a sub-dollar token as "0.1234" instead of the raw
// "6617290" blob lightweight-charts falls back to. Used for the price axis and
// the crosshair label.
const priceFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const fmtPrice = (p: number) => priceFmt.format(p);

// `time` is a UTC timestamp in seconds (from /api/markets/candles).
const fmtClock = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
// Crosshair tooltip: full, readable "Jul 21, 14:30".
const fmtStamp = (t: number) =>
  new Date(t * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

// Chart axis font. Must be LITERAL family names only — lightweight-charts sets
// this directly on the <canvas> `ctx.font`, which cannot resolve CSS variables
// (`var(--font-sans-v2)` would make the whole font string invalid and silently
// fall back to the default sans-serif). "Google Sans Variable" is loaded app-
// wide via @fontsource in the root layout.
const CHART_FONT =
  '"Google Sans Variable", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

/** Animated candle skeleton shown while the first candles load. */
function ChartSkeleton() {
  const bars = [42, 66, 54, 78, 60, 86, 48, 72, 58, 90, 64, 76, 52, 82, 62, 74, 56, 88];
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end gap-[2.5%] overflow-hidden px-2 pb-8 pt-3">
      {bars.map((h, i) => (
        <div
          key={i}
          className="flex-1 animate-pulse rounded-[2px] bg-[#15300c]/10"
          style={{ height: `${h}%`, animationDelay: `${i * 70}ms`, animationDuration: "1.1s" }}
        />
      ))}
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70 px-3 py-1 text-[12px] font-medium text-[#7a8a72] backdrop-blur-sm">
        Loading chart…
      </span>
    </div>
  );
}

export function TradeChart({ symbol, interval }: { symbol: string; interval: string }) {
  const elRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null);
  const symRef = useRef(symbol);
  const intRef = useRef(interval);
  const inflight = useRef(false); // skip a poll while one is still loading
  // Fit the view to the data only on the first load and on symbol/interval
  // changes — NOT on every live poll, so the user's scroll/zoom is preserved.
  const fitNext = useRef(true);
  symRef.current = symbol;
  intRef.current = interval;

  const load = useCallback(async () => {
    if (inflight.current) return; // don't stack a second candles request
    inflight.current = true;
    try {
      const r = await fetch(`/api/markets/candles?symbol=${symRef.current}&interval=${intRef.current}`);
      const j = (await r.json()) as { candles?: Candle[]; unavailable?: boolean };
      if (!seriesRef.current) return;
      seriesRef.current.setData(j.candles ?? []);
      if (j.candles?.length) {
        // Only reset the viewport on the first paint / after a symbol or
        // interval switch. Live polls keep whatever the user scrolled to.
        if (fitNext.current) {
          chartRef.current?.timeScale().fitContent();
          fitNext.current = false;
        }
        setLoading(false);
      }
    } catch {
      /* transient */
    } finally {
      inflight.current = false;
    }
  }, []);

  // Create the chart once.
  useEffect(() => {
    let disposed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let ro: ResizeObserver | undefined;
    (async () => {
      const { createChart, CandlestickSeries, ColorType, CrosshairMode } = await import("lightweight-charts");
      if (disposed || !elRef.current) return;
      const el = elRef.current;
      // Size explicitly from the container instead of `autoSize`: inside the
      // flex column the element can measure 0 during the dynamic-import race,
      // which leaves autoSize stuck and the series drawn as a sliver. A manual
      // ResizeObserver always tracks the real box.
      const chart = createChart(el, {
        width: Math.max(el.clientWidth, 1),
        height: Math.max(el.clientHeight, 1),
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#3a5230",
          fontFamily: CHART_FONT,
        },
        grid: {
          vertLines: { color: "rgba(21,48,12,0.06)" },
          horzLines: { color: "rgba(21,48,12,0.06)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        // Readable axes: commas + decimals on price, real dates/times on the
        // axis and crosshair label.
        localization: {
          priceFormatter: fmtPrice,
          timeFormatter: (time: Time) => fmtStamp(time as unknown as number),
        },
        rightPriceScale: { borderColor: "rgba(21,48,12,0.12)" },
        timeScale: {
          borderColor: "rgba(21,48,12,0.12)",
          timeVisible: true,
          secondsVisible: false,
          // "14:30" for intraday ticks, "Jul 21" for day/month/year ticks.
          tickMarkFormatter: (time: Time, tickMarkType: number) =>
            tickMarkType >= 3
              ? fmtClock(time as unknown as number)
              : fmtDay(time as unknown as number),
        },
        // Let the user pan and zoom freely (defaults, set explicitly so the
        // terminal never feels locked).
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: "#2f9e44",
        downColor: "#e0574f",
        borderVisible: false,
        wickUpColor: "#2f9e44",
        wickDownColor: "#e0574f",
        // Custom formatter so axis ticks match the localization (commas + up to
        // 4 dp); minMove lets ticks resolve down to 4 decimals for cheap assets.
        priceFormat: { type: "custom", formatter: fmtPrice, minMove: 0.0001 },
      });
      chartRef.current = chart;
      seriesRef.current = series;
      // Keep the chart sized to its container across layout/flex changes.
      ro = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box && box.width > 0 && box.height > 0) {
          chart.resize(box.width, box.height);
        }
      });
      ro.observe(el);
      // Canvas text uses whatever font is loaded at draw time and does NOT
      // repaint when a web font arrives later. Once Google Sans is ready,
      // re-apply the layout to force a redraw so the axis picks it up.
      if (typeof document !== "undefined" && document.fonts?.ready) {
        document.fonts.ready.then(() => {
          if (!disposed) chartRef.current?.applyOptions({ layout: { fontFamily: CHART_FONT } });
        });
      }
      await load();
      // Skip the refresh while the tab is backgrounded — no point redrawing a
      // chart no one is watching (saves RPC + battery).
      poll = setInterval(() => { if (document.visibilityState === "visible") load(); }, 5000);
    })();
    return () => {
      disposed = true;
      if (poll) clearInterval(poll);
      ro?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [load]);

  // Reload on symbol / interval change, show the skeleton until it lands.
  // Clear the in-flight guard so the switch always fetches immediately even if
  // a poll for the previous symbol was mid-flight.
  useEffect(() => {
    setLoading(true);
    inflight.current = false;
    fitNext.current = true; // re-fit the view for the new symbol/interval
    void load();
  }, [symbol, interval, load]);

  return (
    // letter-spacing:normal — the app-wide −0.05em tracking otherwise bleeds into
    // the chart's canvas axis text (Chrome honors the canvas element's CSS
    // letter-spacing), cramping the price/date labels.
    <div className="relative h-full w-full" style={{ letterSpacing: "normal" }}>
      <div ref={elRef} className="h-full w-full" style={{ letterSpacing: "normal" }} />
      {loading && <ChartSkeleton />}
    </div>
  );
}
