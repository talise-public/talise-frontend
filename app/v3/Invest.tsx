import Image from "next/image";
import Reveal from "./Reveal";
import { AssetIcon } from "@/components/app/markets/AssetIcon";
import { Counter, Ticks } from "./ui";

// `t` = display symbol, `ticker` = the WaterX market id the perps icon proxy
// (/api/asset-icon/<TICKER>) resolves the real coin logo from.
const COINS: { t: string; ticker: string; chg: string }[] = [
  { t: "BTC", ticker: "BTCUSD", chg: "+1.8%" },
  { t: "ETH", ticker: "ETHUSD", chg: "+2.4%" },
  { t: "SOL", ticker: "SOLUSD", chg: "+5.1%" },
  { t: "SUI", ticker: "SUIUSD", chg: "+3.6%" },
];

/** A green PnL share card featuring the Talise anime girl (green-tinted). */
function PnlCard() {
  const chart = "0,48 20,46 40,44 60,45 80,40 100,38 120,39 140,33 160,30 180,27 200,21 220,17 240,13";
  return (
    <div
      className="relative w-full max-w-[540px] overflow-hidden rounded-2xl border border-white/12"
      style={{
        aspectRatio: "1.5 / 1",
        background: "linear-gradient(135deg, #0f2a15 0%, #0a1a0e 58%, #0a0e0b 100%)",
        boxShadow: "0 40px 100px -30px rgba(0,0,0,0.7)",
      }}
    >
      {/* anime girl, recoloured green + faded into the card */}
      <div className="absolute inset-y-0 right-0 w-[50%]" style={{ isolation: "isolate" }}>
        <Image src="/v3/anime-girl.png" alt="A Talise user checking her phone" fill sizes="270px" className="object-cover object-top" style={{ filter: "contrast(1.05) saturate(0.5)" }} />
        <div className="absolute inset-0" style={{ background: "#2f7d2f", mixBlendMode: "color" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, #0d2211 0%, rgba(13,34,17,0.72) 34%, rgba(13,34,17,0.12) 74%, transparent 100%)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(0deg, rgba(10,14,11,0.55) 0%, transparent 42%)" }} />
      </div>

      {/* stats */}
      <div className="relative z-10 flex h-full flex-col justify-between p-6">
        <div className="flex items-center gap-2.5">
          <AssetIcon ticker="SOLUSD" size={28} />
          <div>
            <div className="text-[15px] font-[500] leading-tight text-[#f2f4f2]" style={{ fontFamily: "var(--font-display-v3)" }}>SOL-PERP</div>
            <div className="text-[11px] text-[#8f978c]" style={{ fontFamily: "var(--font-mono), monospace" }}>Long · 10×</div>
          </div>
        </div>

        <div>
          <div className="text-[clamp(38px,6vw,52px)] font-[500] leading-none text-[#8fe37f]" style={{ fontFamily: "var(--font-display-v3)", letterSpacing: "-0.02em" }}>+21.4%</div>
          <div className="mt-1.5 text-[17px] text-[#d6dbd2]" style={{ fontFamily: "var(--font-mono), monospace" }}>+$42.18</div>
          <svg viewBox="0 0 240 60" preserveAspectRatio="none" className="mt-4 h-12 w-[72%]" aria-hidden>
            <polyline points={chart} fill="none" stroke="#7fd06e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#8f978c]" style={{ fontFamily: "var(--font-mono), monospace" }}>
          <span>Entry <span className="text-[#e7ece3]">$63.90</span></span>
          <span>Exit <span className="text-[#e7ece3]">$77.41</span></span>
          <span>Closed <span className="text-[#e7ece3]">now</span></span>
        </div>
      </div>
    </div>
  );
}

const POINTS = [
  ["Go long or short", "- up to 10× leverage on major markets."],
  ["BTC · ETH · SOL · SUI", "- the pairs people actually trade."],
  ["No wallet, no bridge", "- trade from your Talise balance."],
  ["Simple fees", "- nothing to pay until you close."],
];

export default function Invest() {
  return (
    <section id="invest" className="relative bg-[#0a0e0b]">
      {/* seam glow from the card section above */}
      <div className="relative mx-auto max-w-[1280px] border-x border-t border-white/10 px-5 py-20 sm:px-8">
        <Ticks mint />
        <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
          {/* copy */}
          <Reveal>
            <span className="inline-flex items-center gap-2 border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#CAFFB8]" style={{ fontFamily: "var(--font-mono), monospace" }}>
              <span className="inline-block h-2 w-2 bg-[#CAFFB8]" /> Invest · live
            </span>
            <h2 className="mt-7 max-w-[15ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[#f2f4f2]" style={{ fontFamily: "var(--font-display-v3)" }}>
              Trade perps, right in your wallet
            </h2>
            <p className="mt-5 max-w-[46ch] text-[16px] leading-[1.55] text-[#b9c0bb]">
              Go long or short on the markets you know, powered by WaterX,
              settled on Sui, funded straight from your dollars. No exchange
              account, no wallet juggling.
            </p>

            {/* coin markets strip */}
            <div className="mt-8 flex flex-wrap gap-2.5">
              {COINS.map((c) => (
                <div key={c.t} className="flex items-center gap-2.5 rounded-full border border-white/12 bg-white/[0.03] py-1.5 pl-1.5 pr-3.5">
                  <AssetIcon ticker={c.ticker} size={28} />
                  <span className="text-[13px] font-[600] text-[#eef1ec]" style={{ fontFamily: "var(--font-mono), monospace" }}>{c.t}</span>
                  <span className="text-[12px] text-[#7fd06e]" style={{ fontFamily: "var(--font-mono), monospace" }}>{c.chg}</span>
                </div>
              ))}
            </div>

            <ul className="mt-8 border-t border-white/10">
              {POINTS.map(([t, d]) => (
                <li key={t} className="flex items-center gap-3.5 border-b border-white/10 py-3.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#CAFFB8]/15">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#CAFFB8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-[15px] font-[500] text-[#eef1ec]" style={{ fontFamily: "var(--font-display-v3)" }}>{t}</span>
                    <span className="text-[13.5px] text-[#8f978c]">{d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>

          {/* green PnL share card featuring the Talise anime girl */}
          <Reveal delay={120} className="flex justify-center py-4">
            <PnlCard />
          </Reveal>
        </div>

        <div className="v3-hatch mt-6 h-14 opacity-40" />
        <div className="pt-2"><Counter n="05" label="Invest & perps" dark /></div>
      </div>
    </section>
  );
}
