import Reveal from "./Reveal";
import { Counter, Kicker, Ticks } from "./ui";

const ITEMS: { t: string; d: string; icon: React.ReactNode }[] = [
  { t: "Talise Copilot", d: "Ask an AI to move your money in plain language.", icon: <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4L12 3z" /> },
  { t: "Cheques", d: "Send a claimable money link to anyone.", icon: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></> },
  { t: "Streaming", d: "Pay by the second, salaries, rent, subs.", icon: <path d="M4 12h4l2-6 4 12 2-6h4" /> },
  { t: "Automations", d: "Set money rules that run on their own.", icon: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3m9-9h-3M6 12H3" /></> },
  { t: "Goals", d: "Lock money toward a target in a vault.", icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></> },
  { t: "Rewards", d: "Earn round-ups and perks as you spend.", icon: <path d="M12 2l2.6 6.6L21 9l-5 4 1.5 7L12 16l-5.5 4L8 13 3 9l6.4-.4L12 2z" /> },
  { t: "Private sends", d: "Shielded transfers when you want them.", icon: <path d="M12 2l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V5l7-3z" /> },
  { t: "Scan to pay", d: "Point your camera and confirm.", icon: <><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><path d="M14 14h6v6h-6z" /></> },
];

export default function More() {
  return (
    <section id="more" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />
      <Reveal className="flex flex-col items-center text-center">
        <Kicker>And much more</Kicker>
        <h2 className="mt-7 max-w-[18ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          Everything else you'd expect, and a few things you won't
        </h2>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          The whole money toolkit, quietly built in. Use what you need today,
          discover the rest as you go.
        </p>
      </Reveal>

      <Reveal className="relative mt-16 grid grid-cols-1 border-y border-[var(--v3-line)] sm:grid-cols-2 lg:grid-cols-4">
        <Ticks />
        {[25, 50, 75].map((p) => (
          <span key={`t${p}`} aria-hidden className="v3-tick hidden lg:block" style={{ left: `${p}%`, top: 0, transform: "translate(-50%,-50%)" }} />
        ))}
        {[25, 50, 75].map((p) => (
          <span key={`b${p}`} aria-hidden className="v3-tick hidden lg:block" style={{ left: `${p}%`, bottom: 0, transform: "translate(-50%,50%)" }} />
        ))}
        {/* mid horizontal tick row (2 rows of 4) */}
        <span aria-hidden className="v3-tick v3-tick-tl" style={{ top: "50%" }} />
        <span aria-hidden className="v3-tick v3-tick-tr" style={{ top: "50%" }} />
        {ITEMS.map((it, i) => (
          <div
            key={it.t}
            className={`p-6 ${i % 2 === 1 ? "sm:border-l sm:border-[var(--v3-line)]" : ""} ${i >= 1 ? "border-t border-[var(--v3-line)] sm:border-t-0" : ""} ${i >= 2 ? "sm:border-t sm:border-[var(--v3-line)]" : ""} ${i >= 4 ? "lg:border-t lg:border-[var(--v3-line)]" : "lg:border-t-0"} lg:border-l lg:border-[var(--v3-line)] lg:[&:nth-child(4n+1)]:border-l-0`}
          >
            <span className="grid h-10 w-10 place-items-center border border-[var(--v3-line)] bg-[var(--v3-white)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--v3-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{it.icon}</svg>
            </span>
            <h3 className="mt-4 text-[16.5px] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{it.t}</h3>
            <p className="mt-1.5 text-[13.5px] leading-[1.5] text-[var(--v3-muted)]">{it.d}</p>
          </div>
        ))}
      </Reveal>

      <div className="v3-hatch h-16" />
      <div className="pb-8"><Counter n="06" label="More features" /></div>
    </section>
  );
}
