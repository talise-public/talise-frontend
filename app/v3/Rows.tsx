import Image from "next/image";
import Reveal from "./Reveal";
import { Counter, Kicker, Ticks } from "./ui";

function Check() {
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--v3-accent-2)]">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1c3d12" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}

function List({ items }: { items: [string, string][] }) {
  return (
    <ul className="mt-8 border-t border-[var(--v3-line)]">
      {items.map(([t, d]) => (
        <li key={t} className="flex items-center gap-4 border-b border-[var(--v3-line)] py-4">
          <Check />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[16px] font-[500] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{t}</span>
            <span className="text-[13.5px] text-[var(--v3-muted)]">{d}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* Earnings mockup (CSS) for row B */
function EarningsWidget() {
  const bars = [46, 58, 40, 72, 55, 88, 64, 96, 78];
  return (
    <div className="w-full max-w-[360px] rounded-xl border border-[var(--v3-line)] bg-[var(--v3-white)] p-6" style={{ boxShadow: "0 30px 70px -34px rgba(18,26,15,0.35)" }}>
      <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>Overall earning</div>
      <div className="mt-1.5 text-[36px] font-[500] leading-none tracking-[-0.02em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>$<span data-countup="4025">4,025</span><span className="text-[var(--v3-dim)]">.08</span></div>
      <div className="mt-5 flex items-end gap-2" style={{ height: 90 }} data-bars>
        {bars.map((h, i) => (
          <div key={i} data-bar className="flex-1 rounded-t-sm" style={{ height: `${h}%`, background: i === 7 ? "var(--v3-accent)" : "rgba(47,106,31,0.2)" }} />
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-[var(--v3-panel)] p-3">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>Total earned</div>
          <div className="mt-1 text-[15px] font-[600] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-mono), monospace" }}>$4,200.00</div>
        </div>
        <div className="rounded-lg bg-[var(--v3-panel)] p-3">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>Withdrawn</div>
          <div className="mt-1 text-[15px] font-[600] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-mono), monospace" }}>−$500.00</div>
        </div>
      </div>
    </div>
  );
}

export default function Rows() {
  return (
    <section id="global" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />
      <Reveal className="flex flex-col items-center text-center">
        <Kicker>Built to remove friction</Kicker>
        <h2 className="mt-7 max-w-[18ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          Move money the way you think about it
        </h2>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          Not accounts and addresses, people, goals and destinations. Talise
          handles the rest quietly in the background.
        </p>
      </Reveal>

      {/* row A */}
      <Reveal className="relative mt-16 grid grid-cols-1 items-center gap-10 border-t border-[var(--v3-line)] py-14 lg:grid-cols-2 lg:gap-16">
        <span aria-hidden className="v3-tick v3-tick-tl" />
        <span aria-hidden className="v3-tick v3-tick-tr" />
        <div className="relative mx-auto w-full max-w-[280px]">
          <div className="overflow-hidden rounded-[32px] border-[5px] border-[#0c110c] bg-[#0a0e0b]" style={{ boxShadow: "0 40px 90px -34px rgba(18,26,15,0.4)" }}>
            <Image src="/v3/move-money.png" alt="Talise Move money screen, cash out, send, send abroad, send privately, and more" width={919} height={1998} className="h-auto w-full" />
          </div>
        </div>
        <div>
          <h3 className="text-[clamp(20px,2.3vw,27px)] leading-[1.1] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
            Pay anyone, anywhere
          </h3>
          <p className="mt-4 max-w-[46ch] text-[15.5px] leading-[1.55] text-[var(--v3-muted)]">
            Send money as easily as a text. Every transfer is instant and
            gasless, whether it's across the table or across the world.
          </p>
          <List
            items={[
              ["Send by @handle", "- a name, not a 42-character address."],
              ["Scan to pay", "- point, confirm, done."],
              ["Cheques", "- a claimable money link for anyone."],
              ["Streaming", "- pay by the second, salaries to rent."],
            ]}
          />
        </div>
      </Reveal>

      {/* row B (reversed) */}
      <Reveal className="relative grid grid-cols-1 items-center gap-10 border-t border-[var(--v3-line)] py-14 lg:grid-cols-2 lg:gap-16">
        <span aria-hidden className="v3-tick v3-tick-tl" />
        <span aria-hidden className="v3-tick v3-tick-tr" />
        <div className="lg:order-2 lg:flex lg:justify-end">
          <EarningsWidget />
        </div>
        <div className="lg:order-1">
          <h3 className="text-[clamp(20px,2.3vw,27px)] leading-[1.1] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
            Grow your money
          </h3>
          <p className="mt-4 max-w-[46ch] text-[15.5px] leading-[1.55] text-[var(--v3-muted)]">
            From first-time savers to active traders, earning, investing and
            planning built right in, no second app required.
          </p>
          <List
            items={[
              ["Earn", "- auto-yield on idle dollars."],
              ["Perps", "- trade with leverage in-app."],
              ["Goals", "- lock money toward a target."],
              ["Automations", "- money rules that run themselves."],
            ]}
          />
        </div>
      </Reveal>

      <div className="v3-hatch h-16" />
      <div className="pb-8"><Counter n="03" label="How Talise helps" /></div>
    </section>
  );
}
