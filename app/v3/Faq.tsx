"use client";

import { useState } from "react";
import { Kicker, Ticks } from "./ui";

const QA = [
  ["Do I need to know anything about crypto?", "No. You sign in with Google or Apple, and your balance shows in plain dollars. No seed phrase, no wallet to install, no gas to buy, the blockchain part stays invisible."],
  ["Is my money actually real dollars?", "Your balance is fully-backed digital dollars, redeemable 1:1. It's not a points system or a promise, it's real value you hold, send, or cash out at any time."],
  ["How do I get money out?", "Cash out to your local bank account in your own currency, usually within minutes. You can also send to anyone else on Talise instantly by their @handle."],
  ["What does it cost?", "Talise sponsors the network fee on every transaction, so sending and receiving is free of gas. Currency conversion and cash-out carry a small, clearly-shown spread, no hidden charges."],
  ["Is it secure?", "Your money sits in your own non-custodial account on Sui, only you can move it. Sign-in uses zkLogin, so there's no seed phrase to lose, and balances can be shielded for privacy."],
  ["Which countries can I send to?", "Talise is rolling out corridor by corridor across Africa, Asia and beyond. Open the app to see the destinations live today, new ones are added regularly."],
];

function Item({ q, a, n }: { q: string; a: string; n: number }) {
  const [open, setOpen] = useState(n === 0);
  return (
    <div className="border-b border-[var(--v3-line)]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-4 py-5 text-left">
        <span className="text-[12px] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>0{n + 1}</span>
        <span className="flex-1 text-[17px] font-[400] tracking-[-0.01em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{q}</span>
        <span className={`grid h-8 w-8 shrink-0 place-items-center transition-colors ${open ? "bg-[var(--v3-accent)] text-[#f4fbef]" : "bg-[var(--v3-white)] text-[var(--v3-ink)] border border-[var(--v3-line)]"}`} aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14" />{!open && <path d="M12 5v14" />}</svg>
        </span>
      </button>
      <div className={`v3-faq-body ${open ? "is-open" : ""}`}>
        <div><p className="max-w-[70ch] pb-6 pl-9 text-[14.5px] leading-[1.6] text-[var(--v3-muted)]">{a}</p></div>
      </div>
    </div>
  );
}

export default function Faq() {
  return (
    <section id="faq" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Kicker>Questions</Kicker>
          <h2 className="mt-7 max-w-[12ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
            Got questions? Clear answers.
          </h2>
          <p className="mt-5 max-w-[38ch] text-[15px] leading-[1.55] text-[var(--v3-muted)]">
            Still unsure? <a href="mailto:hello@talise.io" className="text-[var(--v3-accent)] underline underline-offset-2">Contact us</a> and we'll help.
          </p>
        </div>
        <div className="border-t border-[var(--v3-line)]">
          {QA.map(([q, a], i) => (
            <Item key={q} q={q} a={a} n={i} />
          ))}
        </div>
      </div>

      <div className="v3-hatch mt-16 h-16" />
      <div className="pb-8" />
    </section>
  );
}
