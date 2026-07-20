"use client";

/**
 * TradeChart, TradingView lightweight-charts candlesticks for the perps
 * terminal. Candles are proxied from Binance spot via /api/markets/candles
 * (WaterX drives the on-chain perp state; price history mirrors the deep spot
 * market of the same asset). Chart instance persists across symbol/interval
 * changes; data is refreshed on change and polled live.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Candle = { time: number; open: number; high: number; low: number; close: number };

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
        chartRef.current?.timeScale().fitContent();
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
          fontFamily: "var(--font-sans-v2), system-ui, sans-serif",
        },
        grid: {
          vertLines: { color: "rgba(21,48,12,0.06)" },
          horzLines: { color: "rgba(21,48,12,0.06)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "rgba(21,48,12,0.12)" },
        timeScale: { borderColor: "rgba(21,48,12,0.12)", timeVisible: true, secondsVisible: false },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: "#2f9e44",
        downColor: "#e0574f",
        borderVisible: false,
        wickUpColor: "#2f9e44",
        wickDownColor: "#e0574f",
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
    void load();
  }, [symbol, interval, load]);

  return (
    <div className="relative h-full w-full">
      <div ref={elRef} className="h-full w-full" />
      {loading && <ChartSkeleton />}
    </div>
  );
}
