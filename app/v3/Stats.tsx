import Reveal from "./Reveal";
import { Counter, Kicker, Ticks } from "./ui";

const STATS = [
  ["<1s", "Transaction finality", "Every send confirms in under a second."],
  ["$0", "Network fees", "Gas is sponsored on every transaction."],
  ["100%", "Self-custody", "Your keys, your money, always yours."],
  ["24/7", "Always on", "Move money any hour, any day of the year."],
];

export default function Stats() {
  return (
    <section id="why" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />

      <Reveal className="flex flex-col items-center text-center">
        <Kicker>Measurable difference</Kicker>
        <h2 className="mt-7 max-w-[16ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          Real money. Real speed. Real control.
        </h2>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          Built on Sui and engineered so the fast, safe path is also the simple
          one, no crypto knowledge required.
        </p>
      </Reveal>

      {/* stat row */}
      <Reveal className="relative mt-16 grid grid-cols-2 border-y border-[var(--v3-line)] md:grid-cols-4">
        <Ticks />
        {/* interior divider ticks (md+) */}
        {[25, 50, 75].map((p) => (
          <span key={`t${p}`} aria-hidden className="v3-tick hidden md:block" style={{ left: `${p}%`, top: 0, transform: "translate(-50%,-50%)" }} />
        ))}
        {[25, 50, 75].map((p) => (
          <span key={`b${p}`} aria-hidden className="v3-tick hidden md:block" style={{ left: `${p}%`, bottom: 0, transform: "translate(-50%,50%)" }} />
        ))}
        {/* interior tick for 2-col mobile */}
        <span aria-hidden className="v3-tick md:hidden" style={{ left: "50%", top: 0, transform: "translate(-50%,-50%)" }} />
        <span aria-hidden className="v3-tick md:hidden" style={{ left: "50%", bottom: 0, transform: "translate(-50%,50%)" }} />

        {STATS.map(([n, label, desc], i) => (
          <div
            key={label}
            className={`px-5 py-8 sm:px-7 ${i % 2 === 1 ? "border-l border-[var(--v3-line)]" : ""} ${i >= 2 ? "border-t border-[var(--v3-line)] md:border-t-0" : ""} md:border-l md:border-[var(--v3-line)] md:first:border-l-0`}
          >
            <div className="text-[clamp(30px,4vw,46px)] font-[500] leading-none tracking-[-0.02em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
              {n}
            </div>
            <div className="mt-5 text-[11px] uppercase tracking-[0.12em] text-[var(--v3-accent)]" style={{ fontFamily: "var(--font-mono), monospace" }}>
              {label}
            </div>
            <p className="mt-2.5 text-[14px] leading-[1.5] text-[var(--v3-muted)]">{desc}</p>
          </div>
        ))}
      </Reveal>

      <div className="v3-hatch h-16" />
      <div className="pb-8"><Counter n="01" label="Why Talise" /></div>
    </section>
  );
}
