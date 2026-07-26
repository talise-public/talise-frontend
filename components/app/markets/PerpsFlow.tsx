"use client";

/**
 * Talise Perps — the guided "conviction flow". Same audited WaterX rails as
 * PerpsTerminal (live /api/markets data + the account→deposit→order loop on the
 * zkLogin + Onara sponsored rail), reshaped into one-decision-per-screen:
 *   ① Market → ② Direction & Leverage → ③ Size (live payoff arc) → ④ Launch.
 * Gated behind FEATURE_PERPS (503 → "off").
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetIcon } from "@/components/app/markets/AssetIcon";
import { TradeChart } from "@/components/app/markets/TradeChart";
import { PnLCard, type PnLCardData } from "@/components/app/markets/PnLCard";
import { signSponsorReadyBytes, friendlyError } from "@/components/app/cheques/signBytes";
import { assetMeta } from "@/lib/waterx-assets";

type Market = {
  symbol: string; name: string; sym: string; category: string; marketId: string; paused: boolean; refPriceUsd: number; maxLeverage: number;
  longOiTokens: number; shortOiTokens: number; maxLongSize: number; maxShortSize: number;
  availLongSize: number; availShortSize: number; minCollUsd: number;
  maintenanceMarginPct: number; fundingRatePct: number; fundingIntervalHrs: number; tradingFeeBps: number;
};
type Quote = { spot?: number; change24h?: number; volume24h?: number };
type Position = { ticker: string; positionId: string; isLong: boolean; sizeTokens: number; collateralUsd: number; entryPriceUsd: number; markPriceUsd: number; liqPriceUsd: number; leverage: number; pnlUsd: number; hasTpSl: boolean };
type Account = { accountId: string | null; address?: string; availableUsd?: number; positions?: Position[] };
type Trade = { ts: number; type: string; ticker?: string; side?: string; sizeTokens?: number; priceUsd?: number; collateralUsd?: number; pnlUsd?: number; feeUsd?: number; digest?: string };

const INK = "#15300c", LONG = "#2f9e44", SHORT = "#e0574f", MINT = "#CAFFB8", FOREST = "#2f6d1f", CLAY = "#b0542f", DIM = "#8b9683";
const NUM = "'Google Sans Variable', var(--font-sans-v2), system-ui, sans-serif";
const DISPLAY = '"TWK Everett", var(--font-display-v2), system-ui, sans-serif';

const fmtP = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toFixed(4));
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
const short = (s?: string) => (s && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s || "");
const fmtPnl = (n: number) => (Math.abs(n) < 0.005 ? "$0.00" : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`);

const STEPS = ["Market", "Direction", "Size", "Launch"];

export function PerpsFlow() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [spotMap, setSpotMap] = useState<Record<string, number>>({});
  const [changeMap, setChangeMap] = useState<Record<string, number>>({});
  const [chartSym, setChartSym] = useState<string | null>(null);
  const [chartIv, setChartIv] = useState("15m");
  const [quote, setQuote] = useState<Quote>({});
  const [account, setAccount] = useState<Account>({ accountId: null });

  const [step, setStep] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  const [isLong, setIsLong] = useState(true);
  const [leverage, setLeverage] = useState(10);
  const [amountUsd, setAmountUsd] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [launched, setLaunched] = useState<null | { side: string; sym: string; lev: number; margin: number; digest?: string }>(null);
  const [depOpen, setDepOpen] = useState(false);
  const [depAmt, setDepAmt] = useState("");
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tab, setTab] = useState<"trade" | "positions" | "history">("trade");
  const [history, setHistory] = useState<Trade[]>([]);
  const [pnlCard, setPnlCard] = useState<PnLCardData | null>(null);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); window.clearTimeout((flash as unknown as { _t?: number })._t); (flash as unknown as { _t?: number })._t = window.setTimeout(() => setToast(null), 5000); };

  const market = useMemo(() => markets.find((m) => m.symbol === sel), [markets, sel]);
  const selMeta = sel ? assetMeta(sel) : null;
  const maxLev = Math.max(1, Math.floor(market?.maxLeverage ?? 25));
  const levPresets = useMemo(() => [...new Set([2, 5, 10, maxLev])].filter((v) => v >= 1 && v <= maxLev), [maxLev]);
  const price = quote.spot ?? (sel ? spotMap[sel] : 0) ?? market?.refPriceUsd ?? 0;

  // ---- data (guarded polling, exactly like the terminal) ----
  const inflight = useRef<Record<string, boolean>>({});
  const guarded = useCallback((key: string, fn: () => Promise<void>): Promise<void> => {
    if (inflight.current[key]) return Promise.resolve();
    inflight.current[key] = true;
    return fn().finally(() => { inflight.current[key] = false; });
  }, []);
  const loadMarkets = useCallback(() => guarded("markets", async () => {
    try { const r = await fetch("/api/markets"); if (r.status === 503) { setDisabled(true); return; } const j = await r.json(); setMarkets((j.markets ?? []).map((m: Market) => ({ ...m, maxLeverage: Math.max(1, Math.floor(m.maxLeverage || 0)) }))); } catch { /* */ }
  }), [guarded]);
  const loadSpots = useCallback(() => guarded("spots", async () => { try { const r = await fetch("/api/markets/quotes"); if (r.ok) { const j = await r.json(); setSpotMap(j.quotes ?? {}); setChangeMap(j.changes ?? {}); } } catch { /* */ } }), [guarded]);
  const loadAccount = useCallback(() => guarded("account", async () => { try { const r = await fetch("/api/markets/account"); if (r.ok) setAccount(await r.json()); } catch { /* */ } }), [guarded]);
  const loadQuote = useCallback((s: string) => guarded(`quote:${s}`, async () => { try { setQuote(await (await fetch(`/api/markets/quote?symbol=${s}`)).json()); } catch { /* */ } }), [guarded]);
  const loadHistory = useCallback(() => guarded("history", async () => { try { const r = await fetch("/api/markets/history"); if (r.ok) setHistory((await r.json()).trades ?? []); } catch { /* */ } }), [guarded]);

  useEffect(() => {
    const vis = () => document.visibilityState === "visible";
    loadMarkets(); loadAccount(); loadSpots(); loadHistory();
    const m = window.setInterval(() => { if (vis()) loadMarkets(); }, 15000);
    const a = window.setInterval(() => { if (vis()) loadAccount(); }, 6000);
    const s = window.setInterval(() => { if (vis()) loadSpots(); }, 15000);
    return () => { window.clearInterval(m); window.clearInterval(a); window.clearInterval(s); };
  }, [loadMarkets, loadAccount, loadSpots, loadHistory]);
  useEffect(() => { if (!sel) return; loadQuote(sel); const id = window.setInterval(() => { if (document.visibilityState === "visible") loadQuote(sel); }, 3000); return () => window.clearInterval(id); }, [sel, loadQuote]);
  useEffect(() => { setLeverage((lv) => Math.min(lv, maxLev) || 10); }, [maxLev]);

  // ---- derived math (mirrors the terminal) ----
  const mm = (market?.maintenanceMarginPct ?? 0) / 100;
  const notionalUsd = amountUsd * leverage;
  const sizeTokens = price > 0 ? notionalUsd / price : 0;
  const liqFrac = Math.max(0.001, 1 / leverage - mm);           // fraction move to liquidation
  const liqPrice = price > 0 ? (isLong ? price * (1 - liqFrac) : price * (1 + liqFrac)) : 0;
  const totalFeeUsd = notionalUsd * ((market?.tradingFeeBps ?? 0) / 1e4);
  const availableUsd = account.availableUsd ?? 0;
  const minMargin = (() => { const base = (market?.minCollUsd ?? 0) > 0 ? market!.minCollUsd : 1; let m = Math.ceil(base * 10) / 10; if (m <= base + 0.001) m += 0.1; return m; })();
  const availSize = isLong ? market?.availLongSize ?? 0 : market?.availShortSize ?? 0;
  const maxAmount = price > 0 && leverage > 0 ? Math.max(0, Math.min(availableUsd, (availSize * price) / leverage)) : availableUsd;
  const canPlace = amountUsd >= minMargin && amountUsd <= availableUsd + 0.001 && amountUsd <= maxAmount + 0.01 && sizeTokens > 0 && !busy;

  // Live positions: re-mark against the freshest spot; PnL updates as it moves.
  const livePositions = (account.positions ?? []).map((p) => {
    const mark = p.ticker === sel ? (quote.spot ?? p.markPriceUsd) : (spotMap[p.ticker] ?? p.markPriceUsd);
    const pnl = p.sizeTokens * (mark - p.entryPriceUsd) * (p.isLong ? 1 : -1);
    return { ...p, mark, pnl, pnlPct: p.collateralUsd > 0 ? (pnl / p.collateralUsd) * 100 : 0 };
  });
  const totalPnl = livePositions.reduce((s, p) => s + p.pnl, 0);

  // ---- actions (identical rail to the terminal) ----
  const runAction = async (url: string, body: unknown): Promise<{ digest?: string; accountId?: string; mode?: string; bytes?: string; amountUsd?: number; feeUsd?: number }> => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status, code: j.code });
    if (j.mode === "sponsored" && j.bytes) { const { digest } = await signSponsorReadyBytes(j.bytes, { via: "markets" }); return { ...j, digest }; }
    return j;
  };
  const record = (t: Record<string, unknown>) => { fetch("/api/markets/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) }).then(() => loadHistory()).catch(() => {}); };
  const ensureAccount = async (): Promise<string | null> => {
    if (account.accountId) return account.accountId;
    const j = await runAction("/api/markets/account", { op: "create", alias: "Talise" });
    let id = j.accountId ?? null;
    if (!id && j.digest) id = (await runAction("/api/markets/account", { op: "link", digest: j.digest })).accountId ?? null;
    if (id) setAccount((a) => ({ ...a, accountId: id }));
    return id;
  };
  const doDeposit = async () => {
    const amt = Number(depAmt) || 0; if (amt <= 0) return;
    setBusy("deposit");
    try {
      const id = await ensureAccount(); if (!id) throw new Error("Couldn't set up your trading account.");
      const j = await runAction("/api/markets/account", { op: "deposit", accountId: id, amountUsd: amt });
      const actual = j.amountUsd ?? amt;
      record({ type: "deposit", collateralUsd: actual, digest: j.digest });
      flash(true, `Deposited ${usd(actual)} USDsui`);
      setDepOpen(false); setDepAmt(""); await loadAccount();
    } catch (e) { flash(false, friendlyError(e, (e as Error).message)); } finally { setBusy(null); }
  };
  const doOrder = async () => {
    if (!sel) return;
    setBusy("order");
    try {
      const id = await ensureAccount(); if (!id) throw new Error("Couldn't set up your trading account.");
      const acceptablePriceUsd = isLong ? price * 1.01 : price * 0.99;
      const j = await runAction("/api/markets/order/prepare", { ticker: sel, accountId: id, isLong, sizeTokens, collateralUsd: amountUsd, acceptablePriceUsd });
      record({ type: "open", ticker: sel, side: isLong ? "long" : "short", sizeTokens, priceUsd: price, collateralUsd: amountUsd, digest: j.digest });
      setLaunched({ side: isLong ? "Long" : "Short", sym: selMeta!.sym, lev: leverage, margin: amountUsd, digest: j.digest });
      await loadAccount(); loadHistory();
    } catch (e) { flash(false, friendlyError(e, (e as Error).message)); setSlide(0); } finally { setBusy(null); }
  };
  const doClose = async (p: Position & { mark: number; pnl: number; pnlPct: number }) => {
    setClosing((s) => new Set(s).add(p.positionId));
    try {
      const j = await runAction("/api/markets/close", { ticker: p.ticker, accountId: account.accountId, positionId: p.positionId, isLong: p.isLong });
      record({ type: "close", ticker: p.ticker, side: p.isLong ? "long" : "short", sizeTokens: p.sizeTokens, priceUsd: p.mark, pnlUsd: p.pnl, feeUsd: j.feeUsd, digest: j.digest });
      setPnlCard({ ticker: p.ticker, isLong: p.isLong, leverage: p.leverage, entryPriceUsd: p.entryPriceUsd, markPriceUsd: p.mark, pnlUsd: p.pnl, pnlPct: p.pnlPct });
      flash(true, `Closed ${assetMeta(p.ticker).sym}${j.feeUsd ? ` · 2% fee $${j.feeUsd.toFixed(2)}` : ""}${j.digest ? " · " + short(j.digest) : ""}`);
      await loadAccount(); loadHistory();
    } catch (e) { flash(false, friendlyError(e, (e as Error).message)); } finally { setClosing((s) => { const n = new Set(s); n.delete(p.positionId); return n; }); }
  };

  // ---- canvases: risk gauge + payoff arc ----
  const gaugeRef = useRef<HTMLCanvasElement>(null);
  const arcRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (step === 2) drawGauge(); });
  useEffect(() => { if (step === 3) drawArc(); });
  useEffect(() => {
    const on = () => { if (gaugeRef.current) drawGauge(); if (arcRef.current) drawArc(); };
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  });
  function drawGauge() {
    const cv = gaugeRef.current; if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), S = 56;
    cv.width = S * dpr; cv.height = S * dpr; const c = cv.getContext("2d"); if (!c) return; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, S, S);
    const cx = 28, cy = 28, r = 21, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    c.lineWidth = 6; c.lineCap = "round";
    c.beginPath(); c.arc(cx, cy, r, a0, a1); c.strokeStyle = "rgba(21,48,12,.1)"; c.stroke();
    const risk = (leverage - 1) / (maxLev - 1 || 1); const col = risk < 0.4 ? FOREST : risk < 0.72 ? "#c9962a" : CLAY;
    c.beginPath(); c.arc(cx, cy, r, a0, a0 + (a1 - a0) * risk); c.strokeStyle = col; c.stroke();
    c.font = `600 13px ${NUM}`; c.fillStyle = col; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(leverage + "×", cx, cy + 1);
  }
  function drawArc() {
    const cv = arcRef.current; if (!cv) return;
    const wrap = cv.parentElement!; const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = wrap.clientWidth, H = wrap.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext("2d"); if (!c) return; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const padL = 8, padR = 8, padT = 16, padB = 20, gw = W - padL - padR, gh = H - padT - padB;
    const lp = liqFrac * 100; const span = Math.max(lp * 1.35, 4);
    const amt = amountUsd || 1, L = leverage, dir = isLong ? 1 : -1;
    const pnlAt = (mv: number) => Math.max(amt * L * (mv * dir) / 100, -amt);
    const yMax = amt * L * (span / 100), yMin = -amt;
    const X = (mv: number) => padL + (mv + span) / (2 * span) * gw;
    const Y = (p: number) => padT + (yMax - p) / (yMax - yMin) * gh;
    const zeroY = Y(0);
    c.strokeStyle = "rgba(21,48,12,.14)"; c.lineWidth = 1; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(padL, zeroY); c.lineTo(W - padR, zeroY); c.stroke(); c.setLineDash([]);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 120; i++) { const mv = -span + (2 * span) * i / 120; pts.push([X(mv), Y(pnlAt(mv))]); }
    const fillRegion = (sign: number) => { c.beginPath(); c.moveTo(pts[0][0], zeroY); pts.forEach(([x, y]) => c.lineTo(x, sign > 0 ? Math.min(y, zeroY) : Math.max(y, zeroY))); c.lineTo(pts[pts.length - 1][0], zeroY); c.closePath(); c.fillStyle = sign > 0 ? "rgba(202,255,184,.6)" : "rgba(176,84,47,.13)"; c.fill(); };
    fillRegion(1); fillRegion(-1);
    const liqMove = -lp * dir, lx = X(liqMove);
    c.fillStyle = "rgba(176,84,47,.09)"; if (dir > 0) c.fillRect(padL, padT, lx - padL, gh); else c.fillRect(lx, padT, (W - padR) - lx, gh);
    c.strokeStyle = CLAY; c.lineWidth = 1.4; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(lx, padT - 2); c.lineTo(lx, padT + gh); c.stroke(); c.setLineDash([]);
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.strokeStyle = "#234f18"; c.lineWidth = 2.4; c.lineJoin = "round"; c.stroke();
    c.beginPath(); c.arc(X(0), zeroY, 4.5, 0, 7); c.fillStyle = INK; c.fill(); c.strokeStyle = "#fff"; c.lineWidth = 2; c.stroke();
    c.font = `600 9px ${NUM}`; c.fillStyle = CLAY; c.textAlign = dir > 0 ? "left" : "right"; c.fillText("LIQ", lx + (dir > 0 ? 4 : -4), padT + 8);
    c.font = `600 10px ${NUM}`; c.fillStyle = "#234f18"; c.textAlign = "right"; c.fillText("+" + usd(pnlAt(span)), W - padR - 2, Y(pnlAt(span)) + (dir > 0 ? -6 : 12));
    c.font = `8px ${NUM}`; c.fillStyle = DIM; c.textAlign = "center";
    c.fillText("−" + span.toFixed(0) + "%", X(-span), H - 6); c.fillText("entry", X(0), H - 6); c.fillText("+" + span.toFixed(0) + "%", X(span), H - 6);
  }

  // ---- slide-to-open ----
  const [slide, setSlide] = useState(0); // 0..1
  const slideRef = useRef<HTMLDivElement>(null); const dragging = useRef(false);
  const onDown = (e: React.PointerEvent) => { if (busy) return; dragging.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => { if (!dragging.current || !slideRef.current) return; const r = slideRef.current.getBoundingClientRect(); const p = Math.max(0, Math.min(1, (e.clientX - r.left - 30) / (r.width - 60))); setSlide(p); };
  const onUp = () => { if (!dragging.current) return; dragging.current = false; if (slide > 0.82) { setSlide(1); doOrder(); } else setSlide(0); };

  const goMarket = (sym: string) => { setSel(sym); setAmountUsd(0); setStep(2); };
  const reset = () => { setLaunched(null); setSlide(0); setAmountUsd(0); setStep(1); setTab("trade"); };

  // ---------- gates ----------
  if (disabled) return <Centered><h2 className="text-[20px] font-semibold" style={{ color: INK }}>Perps are off</h2><p className="mt-1 text-[14px]" style={{ color: "#3a5230" }}>Set <code>FEATURE_PERPS=true</code> and restart.</p></Centered>;

  const chg = quote.change24h ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 pb-16" style={{ color: INK, fontFamily: NUM }}>
      {/* progress rail */}
      <div className="mb-6 flex items-center gap-2 pt-1">
        {STEPS.map((s, i) => {
          const n = i + 1;
          return (
            <div key={s} className="flex flex-1 flex-col gap-1.5">
              <div className="h-1 overflow-hidden rounded-full" style={{ background: "rgba(21,48,12,.12)" }}>
                <div className="h-full rounded-full transition-[width] duration-500" style={{ width: n <= step ? "100%" : "0%", background: `linear-gradient(90deg, ${FOREST}, #a7ee8c)` }} />
              </div>
              <span className="text-center font-mono text-[8px] uppercase tracking-[0.1em]" style={{ color: n === step ? FOREST : DIM }}>{s}</span>
            </div>
          );
        })}
      </div>

      {step > 1 && !launched && (
        <div className="w-full">
          <button onClick={() => setStep(step - 1)} className="mb-3 flex size-8 items-center justify-center rounded-full border" style={{ borderColor: "rgba(21,48,12,.15)", background: "#fff" }} aria-label="Back">
            <span style={{ fontSize: 15 }}>‹</span>
          </button>
        </div>
      )}

      {/* ---------- STEP 1: MARKET ---------- */}
      {step === 1 && (
        <Section max="none"
          eyebrow={tab === "trade" ? "Step 1 · Market" : tab === "positions" ? "Your positions" : "Trade history"}
          title={tab === "trade" ? <>Pick your <em style={{ fontStyle: "normal", color: FOREST }}>market</em>.</> : tab === "positions" ? <>Your <em style={{ fontStyle: "normal", color: FOREST }}>positions</em>.</> : <>Trade <em style={{ fontStyle: "normal", color: FOREST }}>history</em>.</>}
          sub={tab === "trade" ? "Where do you want to take a position?" : tab === "positions" ? "Live PnL updates as the market moves." : "Opens, closes and transfers — with on-chain receipts."}>
          <div className="mt-4 flex items-center gap-1 border-b" style={{ borderColor: "rgba(21,48,12,.1)" }}>
            {([["trade", "Trade"], ["positions", `Positions${livePositions.length ? ` (${livePositions.length})` : ""}`], ["history", "History"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className="relative px-3.5 py-2.5 text-[13.5px]" style={{ color: tab === k ? INK : "#7a8a72", fontWeight: tab === k ? 600 : 500 }}>
                {label}
                {tab === k && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full" style={{ background: FOREST }} />}
              </button>
            ))}
            {tab === "positions" && livePositions.length > 0 && <span className="ml-auto pr-1 text-[12.5px]" style={{ color: "#586152" }}>Unrealized <b className="tabular-nums" style={{ color: Math.abs(totalPnl) < 0.005 ? "#7a8a72" : totalPnl >= 0 ? LONG : CLAY }}>{fmtPnl(totalPnl)}</b></span>}
          </div>

          {tab === "trade" && (
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
            {markets.length === 0 && <div className="py-10 text-center text-[13px]" style={{ color: DIM }}>Loading markets…</div>}
            {markets.map((m) => {
              const p = spotMap[m.symbol] ?? m.refPriceUsd;
              const chg = changeMap[m.symbol];
              const up = (chg ?? 0) >= 0;
              return (
                <div key={m.symbol} onClick={() => goMarket(m.symbol)} className="group relative flex cursor-pointer flex-col gap-3 rounded-[18px] border bg-white p-3.5 transition-shadow hover:shadow-[0_14px_30px_-20px_rgba(21,48,12,0.5)]" style={{ borderColor: "rgba(21,48,12,.12)" }}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <AssetIcon ticker={m.symbol} size={34} />
                    <span className="min-w-0"><span className="block truncate text-[15px] font-semibold leading-tight">{m.sym}</span><span className="mt-0.5 block truncate font-mono text-[9px] uppercase tracking-[0.06em]" style={{ color: DIM }}>{m.name} · {m.maxLeverage}× max</span></span>
                  </div>
                  <div>
                    <span className="block tabular-nums text-[17px] font-semibold leading-tight" style={{ fontFamily: NUM }}>${fmtP(p)}</span>
                    <span className="mt-0.5 block font-mono text-[10px]" style={{ color: up ? FOREST : CLAY }}>{chg == null ? "—" : `${up ? "▲" : "▼"} ${Math.abs(chg).toFixed(2)}%`}</span>
                  </div>
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[18px] opacity-0 transition-opacity group-hover:opacity-100" style={{ background: "rgba(246,248,241,0.66)" }}>
                    <button onClick={(e) => { e.stopPropagation(); setChartSym(m.symbol); }} className="pointer-events-auto flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11.5px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(21,48,12,0.6)]" style={{ background: INK }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></svg>
                      View chart
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          )}

          {tab === "positions" && (
            <div className="mt-5">
              {livePositions.length === 0 ? (
                <div className="rounded-[18px] border bg-white py-14 text-center" style={{ borderColor: "rgba(21,48,12,.12)" }}>
                  <div className="text-[15px] font-semibold">No open positions</div>
                  <div className="mt-1 text-[13px]" style={{ color: "#586152" }}>Pick a market to place your first trade.</div>
                  <button onClick={() => setTab("trade")} className="mt-4 rounded-[10px] px-4 py-2 text-[13px] font-bold" style={{ background: MINT, color: "#0d2409" }}>Browse markets</button>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {livePositions.map((p) => (
                    <div key={p.ticker + p.positionId} className="rounded-[18px] border bg-white p-4" style={{ borderColor: "rgba(21,48,12,.12)" }}>
                      <div className="flex items-start justify-between">
                        <span className="flex items-center gap-2.5">
                          <AssetIcon ticker={p.ticker} size={30} />
                          <span><span className="block text-[15px] font-semibold leading-tight">{assetMeta(p.ticker).sym}</span><span className="font-mono text-[9.5px] uppercase tracking-[0.06em]" style={{ color: p.isLong ? LONG : CLAY }}>{p.isLong ? "Long" : "Short"}{p.leverage ? ` · ${p.leverage.toFixed(0)}×` : ""}</span></span>
                        </span>
                        <span className="text-right"><span className="block tabular-nums text-[18px] font-semibold leading-tight" style={{ fontFamily: NUM, color: Math.abs(p.pnl) < 0.005 ? "#7a8a72" : p.pnl >= 0 ? LONG : CLAY }}>{fmtPnl(p.pnl)}</span><span className="font-mono text-[10px]" style={{ color: DIM }}>{p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(1)}%</span></span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 rounded-[12px] p-2.5" style={{ background: "#f4f6f1" }}>
                        {([["Entry", `$${fmtP(p.entryPriceUsd)}`], ["Mark", `$${fmtP(p.mark)}`], ["Liq.", `$${fmtP(p.liqPriceUsd)}`]] as const).map(([l, v]) => (
                          <div key={l}><div className="font-mono text-[8.5px] uppercase tracking-[0.08em]" style={{ color: DIM }}>{l}</div><div className="tabular-nums text-[12.5px] font-semibold" style={{ fontFamily: NUM }}>{v}</div></div>
                        ))}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button onClick={() => setPnlCard({ ticker: p.ticker, isLong: p.isLong, leverage: p.leverage, entryPriceUsd: p.entryPriceUsd, markPriceUsd: p.mark, pnlUsd: p.pnl, pnlPct: p.pnlPct })} className="flex-1 rounded-[10px] border py-2 text-[13px] font-semibold" style={{ borderColor: "rgba(21,48,12,.15)" }}>Share</button>
                        <button onClick={() => doClose(p)} disabled={closing.has(p.positionId)} className="flex-1 rounded-[10px] py-2 text-[13px] font-bold text-white disabled:opacity-50" style={{ background: SHORT }}>{closing.has(p.positionId) ? "Closing…" : "Close"}</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "history" && (
            <div className="mt-5">
              {history.length === 0 ? (
                <div className="rounded-[18px] border bg-white py-14 text-center" style={{ borderColor: "rgba(21,48,12,.12)" }}>
                  <div className="text-[15px] font-semibold">No trades yet</div>
                  <div className="mt-1 text-[13px]" style={{ color: "#586152" }}>Your opens, closes and transfers show up here.</div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-[18px] border bg-white" style={{ borderColor: "rgba(21,48,12,.12)" }}>
                  {history.map((t, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? "1px solid rgba(21,48,12,.07)" : "none" }}>
                      <span className="w-[92px] shrink-0 font-mono text-[10px]" style={{ color: DIM }}>{new Date(t.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="flex flex-1 items-center gap-1.5 text-[13px] capitalize">{t.ticker && <AssetIcon ticker={t.ticker} size={18} />}{t.type}{t.side && <span className="text-[10.5px]" style={{ color: t.side === "long" ? LONG : CLAY }}>{t.side}</span>}</span>
                      <span className="tabular-nums text-[12.5px]" style={{ color: t.pnlUsd == null ? "#586152" : Math.abs(t.pnlUsd) < 0.005 ? "#7a8a72" : t.pnlUsd >= 0 ? LONG : CLAY }}>{t.pnlUsd == null ? (t.priceUsd != null ? `$${fmtP(t.priceUsd)}` : t.collateralUsd != null ? usd(t.collateralUsd) : "—") : fmtPnl(t.pnlUsd)}</span>
                      {t.digest ? <a href={`https://suiscan.xyz/mainnet/tx/${t.digest}`} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] underline" style={{ color: FOREST }}>tx↗</a> : <span className="w-6 shrink-0" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {/* ---------- STEP 2: DIRECTION & LEVERAGE ---------- */}
      {step === 2 && market && selMeta && (
        <Section max="none" eyebrow="Step 2 · Direction" title={<>How do you <em style={{ fontStyle: "normal", color: FOREST }}>see it</em>?</>} sub={`${selMeta.sym} / USD · $${fmtP(price)} ${chg ? (chg >= 0 ? "▲" : "▼") + " " + Math.abs(chg).toFixed(2) + "%" : ""}`}>
          <div className="mt-5 grid gap-4 lg:grid-cols-2 lg:items-stretch">
            {/* direction — stacked tiles that fill the column height */}
            <div className="flex flex-col gap-4">
              {([["long", true, LONG, "Long", "You think it climbs", "M4 17l6-6 4 4 6-8 M20 11V7h-4"], ["short", false, CLAY, "Short", "You think it falls", "M4 7l6 6 4-4 6 8 M20 13v4h-4"]] as const).map(([key, val, col, label, desc, path]) => {
                const on = isLong === val;
                return (
                  <button key={key} onClick={() => setIsLong(val)} className="flex flex-1 flex-col justify-between rounded-[22px] border p-6 text-left transition-[transform] active:scale-[.99]" style={{ minHeight: 150, borderColor: on ? col : "rgba(21,48,12,.12)", boxShadow: on ? `0 0 0 1px ${col}` : "none", background: on ? (val ? "linear-gradient(180deg,rgba(202,255,184,.4),#fff)" : "linear-gradient(180deg,rgba(231,195,178,.4),#fff)") : "#fff" }}>
                    <span className="flex size-11 items-center justify-center rounded-[13px]" style={{ background: val ? "rgba(47,109,31,.12)" : "rgba(176,84,47,.12)", color: col }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d={path.split(" M").length > 1 ? path.split(" M")[0] : path} /><path d={"M" + (path.split(" M")[1] ?? "")} /></svg>
                    </span>
                    <span className="mt-4"><span className="block text-[22px] font-semibold leading-tight">{label}</span><span className="mt-1 block text-[13px]" style={{ color: "#586152" }}>{desc}</span></span>
                  </button>
                );
              })}
            </div>
            {/* leverage panel — single column, fills height */}
            <div className="flex flex-col rounded-[22px] border bg-white p-6" style={{ borderColor: "rgba(21,48,12,.12)" }}>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.16em]" style={{ color: DIM }}>Leverage</span>
                <span className="tabular-nums text-[40px] font-semibold leading-none" style={{ fontFamily: NUM, color: FOREST }}>{leverage}<span className="text-[.5em] font-medium">×</span></span>
              </div>
              <div className="relative mt-5 h-3.5 overflow-hidden rounded-lg" style={{ background: "rgba(21,48,12,.12)" }}>
                <div className="absolute inset-y-0 left-0 rounded-lg transition-[width] duration-300" style={{ width: `${((leverage - 1) / (maxLev - 1 || 1)) * 100}%`, background: "linear-gradient(90deg,#a7ee8c,#2f6d1f)", boxShadow: leverage >= maxLev * 0.75 ? "0 0 14px 1px rgba(47,109,31,.5)" : "none" }} />
              </div>
              <input type="range" min={1} max={maxLev} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="mt-3 w-full accent-[#2f6d1f]" aria-label="Leverage" />
              <div className="mt-4 grid grid-cols-4 gap-2">
                {levPresets.map((lv) => <button key={lv} onClick={() => setLeverage(lv)} className="rounded-[11px] py-2.5 text-[14px] font-semibold tabular-nums transition-colors" style={{ background: leverage === lv ? FOREST : "#f4f6f1", color: leverage === lv ? MINT : "#3a5230", fontFamily: NUM }}>{lv}×</button>)}
              </div>
              <div className="mt-auto flex items-center gap-3 rounded-[16px] p-4" style={{ background: "#f4f6f1", marginTop: 20 }}>
                <canvas ref={gaugeRef} style={{ width: 56, height: 56, flex: "none" }} />
                <div><b className="tabular-nums text-[19px]" style={{ color: CLAY, fontFamily: NUM }}>{isLong ? "−" : "+"}{(liqFrac * 100).toFixed(1)}%</b><div className="mt-0.5 text-[12px] leading-snug" style={{ color: "#586152" }}>Liquidates if {selMeta.sym} moves {isLong ? "down" : "up"} this far{liqPrice ? ` (${usd(liqPrice)})` : ""}.</div></div>
              </div>
            </div>
          </div>
          <button onClick={() => setStep(3)} className="mt-4 w-full rounded-[16px] py-4 text-[15px] font-semibold" style={{ background: FOREST, color: MINT }}>Continue</button>
        </Section>
      )}

      {/* ---------- STEP 3: SIZE ---------- */}
      {step === 3 && market && selMeta && (
        <Section max="none" eyebrow="Step 3 · Size" title={<>Size your <em style={{ fontStyle: "normal", color: FOREST }}>position</em>.</>} sub="Margin comes out of your trading balance.">
          <div className="mt-5 grid gap-4 md:grid-cols-2 md:items-stretch">
            <div className="grid gap-3">
              <div className="rounded-[22px] border bg-white p-[18px]" style={{ borderColor: "rgba(21,48,12,.12)" }}>
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.16em]" style={{ color: DIM }}>Margin</span>
                  <span className="font-mono text-[9.5px]" style={{ color: DIM }}>Bal {usd(availableUsd)} · min {usd(minMargin)}</span>
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-[26px] font-medium" style={{ color: DIM, fontFamily: NUM }}>$</span>
                  <input type="number" min={0} step={0.01} value={amountUsd || ""} onChange={(e) => setAmountUsd(Math.max(0, Number(e.target.value)))} placeholder="0" className="w-full bg-transparent tabular-nums text-[44px] font-semibold leading-none outline-none" style={{ fontFamily: NUM, letterSpacing: "-0.03em" }} />
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2">
                  {[25, 50, 75, 100].map((p) => <button key={p} onClick={() => setAmountUsd(Math.floor(maxAmount * p) / 100)} className="rounded-[10px] border py-2 font-mono text-[10.5px] font-semibold tracking-[0.06em] transition-colors" style={{ background: Math.round((amountUsd / (maxAmount || 1)) * 100) === p ? FOREST : "#f4f6f1", color: Math.round((amountUsd / (maxAmount || 1)) * 100) === p ? MINT : "#3a5230", borderColor: "transparent" }}>{p === 100 ? "MAX" : p + "%"}</button>)}
                </div>
                <input type="range" min={0} max={Math.max(0.1, maxAmount)} step={maxAmount / 100 || 0.1} value={Math.min(amountUsd, maxAmount)} onChange={(e) => setAmountUsd(Number(e.target.value))} className="mt-4 w-full accent-[#2f6d1f]" aria-label="Margin" />
              </div>
              <div className="rounded-[16px] border p-3.5" style={{ borderColor: "rgba(21,48,12,.1)", background: "#f4f6f1" }}>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold">Trading balance</span>
                  <span className="tabular-nums text-[16px] font-bold" style={{ color: FOREST, fontFamily: NUM }}>{usd(availableUsd)}</span>
                </div>
                {!depOpen ? (
                  <button onClick={() => { setDepOpen(true); setDepAmt(""); }} className="mt-2.5 w-full rounded-[8px] py-2 text-[13px] font-bold" style={{ background: MINT, color: "#0d2409" }}>+ Deposit USDsui</button>
                ) : (
                  <div className="mt-2.5">
                    <div className="flex items-center rounded-[8px] border bg-white px-2.5" style={{ borderColor: "rgba(21,48,12,.15)" }}>
                      <span className="text-[15px]" style={{ color: DIM }}>$</span>
                      <input autoFocus type="number" min={0} step={0.01} value={depAmt} onChange={(e) => setDepAmt(e.target.value)} placeholder="0.00" className="w-full bg-transparent px-1 py-2.5 tabular-nums text-[16px] font-semibold outline-none" />
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => setDepOpen(false)} className="flex-1 rounded-[8px] border bg-white py-2 text-[13px] font-semibold" style={{ borderColor: "rgba(21,48,12,.15)", color: "#3a5230" }}>Cancel</button>
                      <button onClick={doDeposit} disabled={!!busy || (Number(depAmt) || 0) <= 0} className="flex-1 rounded-[8px] py-2 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: FOREST }}>{busy === "deposit" ? "…" : "Confirm deposit"}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col rounded-[22px] border bg-white p-4" style={{ borderColor: "rgba(21,48,12,.12)" }}>
              <div className="mb-1.5 flex items-center justify-between"><span className="font-mono text-[9.5px] uppercase tracking-[0.16em]" style={{ color: DIM }}>Your payoff</span><span className="font-mono text-[9px]" style={{ color: DIM }}>notional {usd(notionalUsd)} · {leverage}×</span></div>
              <div className="relative min-h-[150px] w-full flex-1"><canvas ref={arcRef} className="block size-full" /></div>
              <div className="mt-3.5 grid grid-cols-3 gap-px overflow-hidden rounded-[14px]" style={{ background: "rgba(21,48,12,.07)", border: "1px solid rgba(21,48,12,.07)" }}>
                {([["If +10%", "+" + usd(amountUsd * leverage * 0.1), FOREST], ["If −10%", "−" + usd(Math.min(amountUsd, amountUsd * leverage * 0.1)), CLAY], ["Liquidation", (isLong ? "−" : "+") + (liqFrac * 100).toFixed(1) + "%", INK]] as const).map(([l, v, col]) => (
                  <div key={l} className="bg-white px-2.5 py-2.5"><div className="font-mono text-[8.5px] uppercase tracking-[0.08em]" style={{ color: DIM }}>{l}</div><div className="mt-1 tabular-nums text-[15px] font-semibold" style={{ color: col, fontFamily: NUM }}>{v}</div></div>
                ))}
              </div>
            </div>
          </div>

          <button onClick={() => setStep(4)} disabled={!canPlace} className="mt-4 w-full rounded-[16px] py-4 text-[15px] font-semibold disabled:opacity-50" style={{ background: FOREST, color: MINT }}>
            {amountUsd <= 0 ? "Enter an amount" : amountUsd < minMargin ? `Min ${usd(minMargin)} to trade` : amountUsd > availableUsd + 0.001 ? "Deposit to trade" : "Review trade"}
          </button>
        </Section>
      )}

      {/* ---------- STEP 4: LAUNCH ---------- */}
      {step === 4 && market && selMeta && !launched && (
        <Section max="none" eyebrow="Step 4 · Launch" title={<>Ready to <em style={{ fontStyle: "normal", color: FOREST }}>launch</em>.</>} sub="One move. Gasless — Talise sponsors it.">
          <div className="mt-5 grid gap-4 md:grid-cols-2 md:items-stretch">
            <div className="rounded-[22px] border bg-white px-[18px]" style={{ borderColor: "rgba(21,48,12,.12)" }}>
              {([["Market", `${selMeta.sym} / USD`, INK], ["Position", `${isLong ? "▲ Long" : "▼ Short"} · ${leverage}×`, isLong ? LONG : CLAY], ["Margin", usd(amountUsd), INK], ["Notional", usd(notionalUsd), INK], ["Entry price", `$${fmtP(price)}`, INK], ["Est. liquidation", `$${fmtP(liqPrice)}`, CLAY], ["Fee", usd(totalFeeUsd), INK]] as const).map(([k, v, col], i) => (
                <div key={k} className="flex items-center justify-between py-3.5" style={{ borderTop: i ? "1px solid rgba(21,48,12,.07)" : "none" }}>
                  <span className="text-[12.5px]" style={{ color: "#586152" }}>{k}</span>
                  <span className="tabular-nums text-[14px] font-semibold" style={{ color: col, fontFamily: NUM }}>{v}</span>
                </div>
              ))}
            </div>

            <div className="flex h-full flex-col rounded-[22px] border bg-white p-5" style={{ borderColor: "rgba(21,48,12,.12)" }}>
              <div className="font-mono text-[9.5px] uppercase tracking-[0.16em]" style={{ color: DIM }}>You&apos;re opening</div>
              <div className="mt-2 text-[24px] font-semibold leading-tight" style={{ fontFamily: NUM, color: isLong ? LONG : CLAY }}>{isLong ? "▲ Long" : "▼ Short"} {selMeta.sym} · {leverage}×</div>
              <div className="mt-1.5 text-[13px]" style={{ color: "#586152" }}>{usd(notionalUsd)} notional · {usd(amountUsd)} margin</div>
              <div className="mt-auto">
                <div className="mt-6 flex items-center justify-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em]" style={{ color: FOREST }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7z" /></svg> No network fee
                </div>
                <div ref={slideRef} className="relative mt-3 flex h-[60px] select-none items-center justify-center overflow-hidden rounded-[30px]" style={{ background: isLong ? LONG : SHORT }}>
                  <div className="absolute inset-y-0 left-0 rounded-[30px]" style={{ width: 60 + slide * ((slideRef.current?.clientWidth ?? 60) - 60), background: "rgba(0,0,0,.14)" }} />
                  <span className="relative text-[15px] font-semibold text-white" style={{ opacity: 1 - slide * 1.4 }}>Slide to open {isLong ? "long" : "short"}</span>
                  <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} className="absolute left-[5px] top-[5px] flex size-[50px] cursor-grab items-center justify-center rounded-full bg-white active:cursor-grabbing" style={{ transform: `translateX(${slide * ((slideRef.current?.clientWidth ?? 60) - 60)}px)`, touchAction: "none" }}>
                    {busy === "order" ? <span className="text-[13px]" style={{ color: isLong ? LONG : SHORT }}>…</span> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isLong ? LONG : SHORT} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* ---------- LAUNCHED ---------- */}
      {launched && (
        <div className="flex flex-col items-center pt-10 text-center">
          <div className="mb-2 flex size-[92px] items-center justify-center rounded-full" style={{ background: MINT }}>
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#234f18" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
          </div>
          <h2 className="text-[26px] font-medium" style={{ letterSpacing: "-0.03em", fontFamily: DISPLAY }}>Position live.</h2>
          <div className="mt-2 font-mono text-[11px]" style={{ color: "#586152" }}>{launched.side} {launched.sym} · {launched.lev}× · {usd(launched.margin)} margin{launched.digest ? " · " + short(launched.digest) : ""}</div>
          <div className="mt-7 flex w-full max-w-[300px] flex-col gap-2.5">
            <button onClick={() => { setLaunched(null); setSlide(0); setStep(1); setTab("positions"); }} className="w-full rounded-[16px] py-4 text-[15px] font-semibold" style={{ background: FOREST, color: MINT }}>View position</button>
            <button onClick={reset} className="w-full rounded-[16px] border py-4 text-[15px] font-semibold" style={{ borderColor: "rgba(21,48,12,.15)" }}>New trade</button>
          </div>
        </div>
      )}

      {/* chart popup — blurred backdrop */}
      {chartSym && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(21,40,10,0.28)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }} onClick={() => setChartSym(null)}>
          <div className="w-full max-w-[900px] rounded-[20px] border p-4 shadow-[0_30px_90px_-24px_rgba(21,48,12,0.6)]" style={{ borderColor: "rgba(21,48,12,.14)", background: "var(--color-surface)" }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2 text-[16px] font-semibold"><AssetIcon ticker={chartSym} size={24} /> {assetMeta(chartSym).sym} <span style={{ color: DIM }}>/ USD</span>
                {changeMap[chartSym] != null && <span className="ml-1 font-mono text-[11px]" style={{ color: changeMap[chartSym] >= 0 ? FOREST : CLAY }}>{changeMap[chartSym] >= 0 ? "▲" : "▼"} {Math.abs(changeMap[chartSym]).toFixed(2)}%</span>}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={() => { const s = chartSym; setChartSym(null); goMarket(s); }} className="rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-bold" style={{ background: MINT, color: "#0d2409" }}>Trade this</button>
                <button onClick={() => setChartSym(null)} aria-label="Close" className="flex size-8 items-center justify-center rounded-full text-[15px]" style={{ background: "rgba(21,48,12,.08)" }}>✕</button>
              </div>
            </div>
            <div className="mb-2.5 flex items-center gap-1">
              {["1m", "15m", "1h", "4h", "1d"].map((iv) => (
                <button key={iv} onClick={() => setChartIv(iv)} className="rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors" style={{ color: chartIv === iv ? INK : "#7a8a72", background: chartIv === iv ? MINT : "transparent" }}>{iv}</button>
              ))}
            </div>
            <div className="h-[440px] w-full"><TradeChart symbol={chartSym} interval={chartIv} /></div>
          </div>
        </div>
      )}
      {pnlCard && <PnLCard data={pnlCard} onClose={() => setPnlCard(null)} />}
      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[10px] px-4 py-2.5 text-[13px] font-medium text-white" style={{ background: toast.ok ? FOREST : SHORT, boxShadow: "0 10px 30px -8px rgba(21,48,12,0.4)" }}>{toast.msg}</div>}
    </div>
  );
}

function Section({ eyebrow, title, sub, children, max = 500 }: { eyebrow: string; title: React.ReactNode; sub: string; children: React.ReactNode; max?: number | "none" }) {
  return (
    <div className="mx-auto" style={{ maxWidth: max === "none" ? undefined : max }}>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.2em]" style={{ color: "#8b9683" }}>{eyebrow}</div>
      <h2 className="mt-1.5 text-[25px] font-medium leading-[1.05]" style={{ letterSpacing: "-0.03em", fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>{title}</h2>
      <p className="mt-1.5 text-[12.5px]" style={{ color: "#586152" }}>{sub}</p>
      {children}
    </div>
  );
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[460px] rounded-[16px] border bg-white p-8 text-center" style={{ borderColor: "rgba(21,48,12,.12)" }}>{children}</div>;
}
