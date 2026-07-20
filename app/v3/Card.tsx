import Image from "next/image";
import Reveal from "./Reveal";
import { Counter, Ticks } from "./ui";

const POINTS = [
  "Spend your dollar balance anywhere Visa is accepted.",
  "Tap to pay from the same money you send and earn.",
  "Virtual card first, with a physical metal card to follow.",
];

/**
 * Skeuomorphic green-leather card holder, a faithful CSS port of the iOS home
 * "coming soon" carousel slide (HomeView.cardComingSoonCard): the Talise Visa
 * card peeks out the top of a stitched leather pocket with an embossed name.
 */
function LeatherCard() {
  return (
    <div className="relative mx-auto aspect-[1.3/1] w-full max-w-[420px]">
      {/* wallet body */}
      <div
        className="absolute inset-0 rounded-[24px]"
        style={{
          background: "radial-gradient(circle at 28% 2%, #2F5F33 0%, #1D3F20 46%, #0E2611 100%)",
          boxShadow:
            "inset 0 1.5px 0 rgba(255,255,255,0.20), inset 0 -3px 8px rgba(0,0,0,0.4), 0 26px 60px -18px rgba(0,0,0,0.7)",
        }}
      />

      {/* the Talise card peeking out the top */}
      <div
        className="absolute left-[7.5%] right-[7.5%] top-[12%] h-[40%] overflow-hidden rounded-[14px]"
        style={{
          background: "linear-gradient(135deg, #16391B 0%, #22582A 52%, #0E2410 100%)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 6px 14px rgba(0,0,0,0.45)",
        }}
      >
        <div className="flex items-start justify-between px-[7%] pt-[7%]">
          <svg width="26" height="24" viewBox="0 0 583 533" aria-hidden>
            <path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill="#ffffff" />
          </svg>
          <Image src="/v3/visa.png" alt="Visa" width={60} height={60} className="h-6 w-auto object-contain" style={{ filter: "brightness(0) invert(1)" }} />
        </div>
      </div>

      {/* front leather pocket (concave top + embossed text) */}
      <div className="absolute bottom-[3.5%] left-[3%] right-[3%] h-[58%]">
        <svg viewBox="0 0 360 200" preserveAspectRatio="none" className="h-full w-full" style={{ filter: "drop-shadow(0 -5px 8px rgba(0,0,0,0.4))" }}>
          <defs>
            <linearGradient id="pocketGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#22492C" />
              <stop offset="0.5" stopColor="#153420" />
              <stop offset="1" stopColor="#0D2413" />
            </linearGradient>
          </defs>
          <path
            d="M0,28 C82.8,28 111.6,3 180,3 C248.4,3 277.2,28 360,28 L360,182 Q360,200 342,200 L18,200 Q0,200 0,182 Z"
            fill="url(#pocketGrad)"
            stroke="rgba(155,210,145,0.12)"
            strokeWidth="1"
          />
        </svg>
        {/* embossed text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 pt-[8%]">
          <div
            className="text-[clamp(20px,2.4vw,26px)] text-[#0f2b16]"
            style={{ fontFamily: "var(--font-display-v3)", textShadow: "0 1px 0.5px rgba(160,215,150,0.28)" }}
          >
            Talise Card
          </div>
          <div
            className="text-[10px] font-[700] text-[#143219]"
            style={{ fontFamily: "var(--font-mono), monospace", letterSpacing: "0.24em", textShadow: "0 1px 0.5px rgba(160,215,150,0.22)" }}
          >
            COMING SOON
          </div>
        </div>
      </div>

      {/* stitching */}
      <div className="pointer-events-none absolute inset-[8px] rounded-[18px]" style={{ border: "1.5px dashed rgba(185,230,170,0.3)" }} />
    </div>
  );
}

export default function Card() {
  return (
    <section id="card" className="relative bg-[#0a0e0b]">
      <div className="relative mx-auto max-w-[1280px] border-x border-white/10 px-5 py-20 sm:px-8">
        <Ticks mint />
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-8">
          {/* copy */}
          <Reveal className="order-2 lg:order-1">
            <span className="inline-flex items-center gap-2 border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#CAFFB8]" style={{ fontFamily: "var(--font-mono), monospace" }}>
              <span className="inline-block h-2 w-2 bg-[#CAFFB8]" /> Coming soon
            </span>
            <h2 className="mt-7 max-w-[14ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[#f2f4f2]" style={{ fontFamily: "var(--font-display-v3)" }}>
              A card for the money you already hold
            </h2>
            <p className="mt-5 max-w-[46ch] text-[16px] leading-[1.55] text-[#b9c0bb]">
              The Talise Card turns your in-app dollars into everyday spend, no
              top-ups, no conversions, no separate balance to manage.
            </p>
            <ul className="mt-8 border-t border-white/10">
              {POINTS.map((p) => (
                <li key={p} className="flex items-center gap-3.5 border-b border-white/10 py-4">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#CAFFB8]/15">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#CAFFB8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                  <span className="text-[14.5px] text-[#d6dbd2]">{p}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          {/* skeuomorphic leather card holder */}
          <Reveal delay={120} className="order-1 lg:order-2">
            <div className="relative py-6">
              <div className="pointer-events-none absolute inset-0 -z-0" style={{ background: "radial-gradient(circle at 60% 45%, rgba(75,138,55,0.28) 0%, transparent 62%)", filter: "blur(24px)" }} />
              <LeatherCard />
            </div>
          </Reveal>
        </div>

        <div className="v3-hatch mt-6 h-14 opacity-40" />
        <div className="pt-2"><Counter n="04" label="Talise Card" dark /></div>
      </div>
    </section>
  );
}
