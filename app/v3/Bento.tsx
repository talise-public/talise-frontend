import Image from "next/image";
import Reveal from "./Reveal";
import { Counter, Kicker, Ticks } from "./ui";

/* ── mini product widgets (CSS, crisp at any size) ─────────────────────────── */

function BalanceWidget() {
  const bars = [40, 62, 48, 78, 90, 70, 96];
  return (
    <div className="flex h-full flex-col justify-between rounded-lg border border-[var(--v3-line)] bg-[var(--v3-white)] p-5">
      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>Total balance</div>
        <div className="mt-1.5 text-[32px] font-[500] leading-none tracking-[-0.02em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>$<span data-countup="2540">2,540</span><span className="text-[var(--v3-dim)]">.18</span></div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--v3-accent-2)] px-2.5 py-1 text-[11px] font-[600] text-[#1c3d12]">+$4.02 today · earning 4.1%</div>
      </div>
      <div className="mt-5 flex items-end gap-1.5" data-bars>
        {bars.map((h, i) => (
          <div key={i} data-bar className="flex-1 rounded-t-sm" style={{ height: `${h * 0.5}px`, background: i === 4 ? "var(--v3-accent)" : "rgba(47,106,31,0.22)" }} />
        ))}
      </div>
    </div>
  );
}

function SendWidget() {
  return (
    <div className="flex h-full flex-col justify-center gap-3 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-white)] p-5">
      <div className="flex items-center justify-between rounded-md border border-[var(--v3-line)] px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--v3-accent-2)] text-[13px] font-[700] text-[#1c3d12]">A</span>
          <div>
            <div className="text-[14px] font-[500] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>@amara</div>
            <div className="text-[11px] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>amara.talise.sui</div>
          </div>
        </div>
        <div className="text-[17px] font-[500] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>$100.00</div>
      </div>
      <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--v3-muted)]">
        <span className="text-[var(--v3-accent)]">✓</span> No network fee, sponsored by Talise
      </div>
      <div className="flex items-center gap-2 overflow-hidden rounded-full bg-[var(--v3-accent)] px-1.5 py-1.5 text-[#f4fbef]">
        <span data-slide className="grid h-7 w-7 place-items-center rounded-full bg-white/25 text-[13px]">»</span>
        <span className="text-[12px] uppercase tracking-[0.08em]" style={{ fontFamily: "var(--font-mono), monospace" }}>Slide to send</span>
      </div>
    </div>
  );
}

function GlobalWidget() {
  const rows = [
    ["/v2/flag-us.png", "/v2/flag-ng.png", "US → Nigeria"],
    ["/v2/flag-gb.png", "/v2/flag-ph.png", "UK → Philippines"],
    ["/v2/flag-ae.png", "/v2/flag-ng.png", "UAE → Nigeria"],
  ];
  return (
    <div className="flex h-full flex-col justify-center gap-2.5 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-white)] p-5" data-rows>
      {rows.map(([f, t, label]) => (
        <div key={label} data-row className="flex items-center justify-between rounded-md border border-[var(--v3-line)] px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex">
              <Image src={f} alt="" width={20} height={20} className="h-5 w-5 rounded-full ring-2 ring-white" />
              <Image src={t} alt="" width={20} height={20} className="-ml-1.5 h-5 w-5 rounded-full ring-2 ring-white" />
            </span>
            <span className="text-[13.5px] font-[500] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{label}</span>
          </div>
          <span className="text-[10.5px] text-[var(--v3-accent)]" style={{ fontFamily: "var(--font-mono), monospace" }}>~ seconds</span>
        </div>
      ))}
    </div>
  );
}

const CELLS = [
  { widget: <BalanceWidget />, title: "Hold & earn", desc: "Keep a real dollar balance that quietly earns yield, withdraw any time, instantly." },
  { widget: <SendWidget />, title: "Send to a name", desc: "Pay anyone by their @handle. No addresses, no seed phrase, no gas fee to cover." },
  { widget: <GlobalWidget />, title: "Send across borders", desc: "Transactions finalize in under a second." },
];

export default function Bento() {
  return (
    <section id="features" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />
      <Reveal className="flex flex-col items-center text-center">
        <Kicker>What you can do</Kicker>
        <h2 className="mt-7 max-w-[18ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          Everything money, in one app
        </h2>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          Holding, sending, saving and cashing out, the tools usually scattered
          across five apps, together in one calm place.
        </p>
      </Reveal>

      <Reveal className="relative mt-16 grid grid-cols-1 border-y border-[var(--v3-line)] md:grid-cols-3">
        <Ticks />
        {[33.333, 66.666].map((p) => (
          <span key={`t${p}`} aria-hidden className="v3-tick hidden md:block" style={{ left: `${p}%`, top: 0, transform: "translate(-50%,-50%)" }} />
        ))}
        {[33.333, 66.666].map((p) => (
          <span key={`b${p}`} aria-hidden className="v3-tick hidden md:block" style={{ left: `${p}%`, bottom: 0, transform: "translate(-50%,50%)" }} />
        ))}
        {CELLS.map((c, i) => (
          <div key={c.title} className={`flex flex-col p-6 sm:p-7 ${i > 0 ? "border-t border-[var(--v3-line)] md:border-l md:border-t-0" : ""}`}>
            <div className="h-[220px]">{c.widget}</div>
            <h3 className="mt-6 text-[19px] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{c.title}</h3>
            <p className="mt-2.5 text-[14.5px] leading-[1.55] text-[var(--v3-muted)]">{c.desc}</p>
          </div>
        ))}
      </Reveal>

      <div className="v3-hatch h-16" />
      <div className="pb-8"><Counter n="02" label="Main features" /></div>
    </section>
  );
}
