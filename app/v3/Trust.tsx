import Reveal from "./Reveal";
import { Counter, Kicker, Ticks } from "./ui";

const P = [
  { t: "Non-custodial", d: "Your money lives in your own on-chain account. Only you can move it, Talise can't touch or freeze it.", icon: <path d="M12 2l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V5l7-3z" /> },
  { t: "Sign in with Google", d: "zkLogin turns a normal Google or Apple sign-in into a wallet. No seed phrase to write down or lose.", icon: <><circle cx="12" cy="9" r="3" /><path d="M4 12h4m8 0h4M12 4v3m0 10v3" /></> },
  { t: "Private by default", d: "Balances and transfers can be shielded, so what you hold and where you send stays your business.", icon: <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 12a2.5 2.5 0 100-.01" /> },
  { t: "Always gasless", d: "Talise sponsors the network fee on every transaction. You never buy a token or think about gas.", icon: <path d="M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z" /> },
];

export default function Trust() {
  return (
    <section id="trust" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />
      <Reveal className="flex flex-col items-center text-center">
        <Kicker>Safe by design</Kicker>
        <h2 className="mt-7 max-w-[16ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          Your money. Your keys.
        </h2>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          The security of self-custody, without the homework, engineered so the
          safe path is also the easy one.
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
        {P.map((p, i) => (
          <div
            key={p.t}
            className={`p-7 ${i % 2 === 1 ? "sm:border-l sm:border-[var(--v3-line)]" : ""} ${i >= 2 ? "border-t border-[var(--v3-line)] lg:border-t-0" : "border-t border-[var(--v3-line)] sm:border-t-0"} lg:border-l lg:border-[var(--v3-line)] lg:first:border-l-0`}
          >
            <span className="grid h-11 w-11 place-items-center border border-[var(--v3-line)] bg-[var(--v3-white)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--v3-accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p.icon}</svg>
            </span>
            <h3 className="mt-5 text-[18px] font-[600] tracking-[-0.01em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{p.t}</h3>
            <p className="mt-2 text-[14px] leading-[1.5] text-[var(--v3-muted)]">{p.d}</p>
          </div>
        ))}
      </Reveal>

      <div className="v3-hatch h-16" />
      <div className="pb-8"><Counter n="07" label="Security" /></div>
    </section>
  );
}
