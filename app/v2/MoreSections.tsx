"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * v2 explainer sections, four bento-styled beats that go deeper on the product:
 *   HowItWorks - get started in three steps
 *   MoreWays   - scan to pay, cheques, streaming
 *   Earn       - idle balance quietly earns
 *   Trust      - google sign-in, non-custodial, private
 * Each uses a single gentle ScrollTrigger reveal (.reveal -> fade + small rise),
 * respects prefers-reduced-motion, and is fully responsive (grids collapse to one
 * column on mobile, fluid type via clamp). Brand tokens only.
 */
function useReveal() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context((self) => {
      gsap.registerPlugin(ScrollTrigger);
      const q = self.selector!;
      gsap.from(q(".reveal"), {
        opacity: 0,
        y: 20,
        duration: 0.7,
        stagger: 0.08,
        ease: "power2.out",
        scrollTrigger: { trigger: root.current, start: "top 80%" },
      });
    }, root);
    return () => ctx.revert();
  }, []);
  return root;
}

const DISPLAY = { fontFamily: "var(--font-display-v2)" } as const;
const HARD = "10px 10px 0 #15300c";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="reveal mb-4 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">{children}</div>;
}

/* ============ 1 - HOW IT WORKS ============ */
const STEPS = [
  { n: "01", t: "Sign in with Google", b: "No seed phrase, no wallet to install. Your account is ready in a tap.", bg: "#CAFFB8" },
  { n: "02", t: "Claim your @handle", b: "Your name is your address. People send to sele@talise, not a long string of characters.", bg: "#FFE59E" },
  { n: "03", t: "Add dollars, then send", b: "Top up, then send to any handle, scan to pay, or drop a cheque. It lands in under a second.", bg: "#C9B8FF" },
];

export function HowItWorks() {
  const root = useReveal();
  return (
    <section ref={root} className="mx-auto max-w-[1400px] px-6 pt-20 pb-12 md:px-12 md:pt-24">
      <div className="mb-12 max-w-[820px]">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="reveal text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
          Set up in{" "}
          <span className="relative inline-block">
            <span className="absolute inset-x-[-6px] inset-y-[5px] -z-0 -rotate-[1.5deg] rounded-[10px] bg-[#CAFFB8]" />
            <span className="relative z-10">a minute.</span>
          </span>
        </h2>
      </div>

      <div className="relative grid grid-cols-1 gap-6 md:grid-cols-3">
        {STEPS.map((s) => (
          <article key={s.n} className="reveal relative rounded-[28px] p-7 md:p-8" style={{ background: s.bg, boxShadow: HARD }}>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#15300c] text-[18px] font-[800] text-[#f7fcf2]" style={DISPLAY}>
              {s.n}
            </div>
            <h3 className="mt-6 text-[clamp(22px,2.6vw,28px)] font-[800] leading-[1.05] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
              {s.t}
            </h3>
            <p className="mt-3 text-[15px] leading-[1.5] text-[#15300c]/75">{s.b}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ============ 2 - MORE WAYS TO MOVE MONEY ============ */
const WAYS = [
  {
    tag: "Scan to pay",
    t: "Tap, scan, paid.",
    b: "Point your camera at a Talise QR and pay in a tap. Splitting a bill or paying a shop, money moves the moment you confirm.",
    bg: "#FF9E7A",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3M21 14v7h-7" />
      </>
    ),
  },
  {
    tag: "Cheques",
    t: "Money by a link.",
    b: "Send a claimable cheque as a link. They open it, claim with their handle, and the amount lands in under a second.",
    bg: "#CAFFB8",
    icon: (
      <>
        <path d="M9 15l6-6" /><path d="M10.5 6.5l1.8-1.8a4 4 0 015.7 5.7l-1.8 1.8" />
        <path d="M13.5 17.5l-1.8 1.8a4 4 0 01-5.7-5.7l1.8-1.8" />
      </>
    ),
  },
  {
    tag: "Streaming",
    t: "Pay by the second.",
    b: "Stream money over time instead of one lump. Made for rent, payroll, or paying as the work happens.",
    bg: "#C9B8FF",
    icon: (
      <>
        <path d="M3 8c3 0 3 3 6 3s3-3 6-3 3 3 6 3" /><path d="M3 14c3 0 3 3 6 3s3-3 6-3 3 3 6 3" />
      </>
    ),
  },
];

export function MoreWays() {
  const root = useReveal();
  return (
    <section ref={root} className="mx-auto max-w-[1400px] px-6 pt-20 pb-12 md:px-12 md:pt-24">
      <div className="mb-12 max-w-[820px]">
        <Eyebrow>Beyond a simple send</Eyebrow>
        <h2 className="reveal text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
          More ways to{" "}
          <span className="relative inline-block">
            <span className="absolute inset-x-[-6px] inset-y-[5px] -z-0 -rotate-[1.5deg] rounded-[10px] bg-[#CAFFB8]" />
            <span className="relative z-10">move money.</span>
          </span>
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {WAYS.map((w) => (
          <article key={w.tag} className="reveal relative rounded-[28px] p-7 md:p-8" style={{ background: w.bg, boxShadow: HARD }}>
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#15300c]/[0.08]">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#15300c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {w.icon}
              </svg>
            </span>
            <div className="mt-6 font-mono text-[11px] uppercase tracking-[0.22em] text-[#15300c]/65">{w.tag}</div>
            <h3 className="mt-2 text-[clamp(22px,2.6vw,28px)] font-[800] leading-[1.05] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
              {w.t}
            </h3>
            <p className="mt-3 text-[15px] leading-[1.5] text-[#15300c]/75">{w.b}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ============ 3 - EARN ============ */
/** Live earning card: the growth line draws on, the balance counts up, then
 *  keeps ticking by the cent to show yield accruing. EARNING badge pulses. */
function EarnCard() {
  const ref = useRef<HTMLDivElement>(null);
  const balRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fmt = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ctx = gsap.context((self) => {
      gsap.registerPlugin(ScrollTrigger);
      const q = self.selector!;
      const bal = balRef.current;
      const obj = { n: 1240 };

      if (reduce) {
        gsap.set(q(".earn-line"), { strokeDashoffset: 0 });
        gsap.set(q(".earn-area, .earn-dot"), { opacity: 1 });
        if (bal) bal.textContent = fmt(1240);
        return;
      }

      gsap.set(q(".earn-line"), { strokeDashoffset: 100 });
      gsap.set(q(".earn-area, .earn-dot"), { opacity: 0 });
      obj.n = 1198;
      if (bal) bal.textContent = fmt(obj.n);

      const tl = gsap.timeline({ scrollTrigger: { trigger: ref.current, start: "top 82%" } });
      tl.to(q(".earn-line"), { strokeDashoffset: 0, duration: 1.4, ease: "power2.out" })
        .to(q(".earn-area"), { opacity: 1, duration: 0.7 }, "<0.3")
        .to(obj, { n: 1240, duration: 1.4, ease: "power2.out", onUpdate: () => { if (bal) bal.textContent = fmt(obj.n); } }, "<")
        .to(q(".earn-dot"), { opacity: 1, duration: 0.3 }, "-=0.2")
        // live yield: keep ticking by the cent (accumulates, never resets)
        .add(() => {
          gsap.timeline({ repeat: -1 }).to({}, { duration: 1.6 }).call(() => {
            obj.n += 0.01;
            if (bal) bal.textContent = fmt(obj.n);
          });
        });

      gsap.to(q(".earn-badge-dot"), { opacity: 0.35, duration: 1, ease: "sine.inOut", yoyo: true, repeat: -1 });
      gsap.to(q(".earn-dot"), { y: -3, duration: 1.5, ease: "sine.inOut", yoyo: true, repeat: -1 });
    }, ref);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={ref} className="reveal relative mx-auto w-full max-w-[420px] rounded-[28px] bg-gradient-to-br from-[#3d7a29] to-[#1c4513] p-8 text-[#f7fcf2]" style={{ boxShadow: "12px 12px 0 #15300c" }}>
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#CAFFB8]">Your balance</div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#CAFFB8] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[#15300c]">
          <span className="earn-badge-dot inline-block h-1.5 w-1.5 rounded-full bg-[#15300c]" /> Earning yield
        </span>
      </div>
      <div ref={balRef} className="mt-2 text-[44px] font-[800] leading-none tabular-nums" style={DISPLAY}>$1,240.00</div>
      <div className="mt-1 font-mono text-[12px] text-[#cfe9c2]">USDsui · auto-routed to Sui protocols</div>
      <svg viewBox="0 0 320 92" className="mt-7 h-[92px] w-full" aria-hidden>
        <path className="earn-area" d="M0 80 C 60 72, 90 60, 140 52 S 230 30, 312 12 L 312 92 L 0 92 Z" fill="#CAFFB8" fillOpacity="0.14" />
        <path className="earn-line" d="M0 80 C 60 72, 90 60, 140 52 S 230 30, 312 12" fill="none" stroke="#CAFFB8" strokeWidth="3" strokeLinecap="round" pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
        <circle className="earn-dot" cx="312" cy="12" r="5" fill="#CAFFB8" />
      </svg>
      <div className="mt-2 font-mono text-[11px] text-[#9fc78c]">working quietly, always withdrawable</div>
    </div>
  );
}

export function Earn() {
  const root = useReveal();
  return (
    <section ref={root} className="mx-auto grid grid-cols-1 max-w-[1400px] items-center gap-12 px-6 pt-20 pb-12 md:px-12 md:pt-24 lg:grid-cols-[1fr_1fr] lg:gap-16">
      <div>
        <Eyebrow>Put dollars to work</Eyebrow>
        <h2 className="reveal text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
          Your money works{" "}
          <span className="relative inline-block">
            <span className="absolute inset-x-[-6px] inset-y-[5px] -z-0 -rotate-[1.5deg] rounded-[10px] bg-[#CAFFB8]" />
            <span className="relative z-10">while it waits.</span>
          </span>
        </h2>
        <p className="reveal mt-6 max-w-[460px] text-[17px] leading-[1.55] text-[#3a5230]">
          Put your dollars to work and they earn yield automatically, auto-routed to vetted Sui protocols. Always liquid, always yours, withdraw any time.
        </p>
        <ul className="reveal mt-7 flex flex-col gap-3">
          {["Earns yield, fully automatic", "Stays fully withdrawable", "Pause or move it whenever"].map((x) => (
            <li key={x} className="flex items-center gap-3 text-[15px] text-[#15300c]/80">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#3d7a29]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f7fcf2" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 6.5" /></svg>
              </span>
              {x}
            </li>
          ))}
        </ul>
      </div>

      <EarnCard />
    </section>
  );
}

/* ============ 4 - TRUST ============ */
const TRUST = [
  {
    tag: "Sign in with Google",
    t: "No seed phrase.",
    b: "zkLogin under the hood. Nothing to write down, nothing to lose, no browser extension to install.",
    bg: "#FFE59E",
    icon: (<><path d="M21 12.2c0-.7-.1-1.3-.2-2H12v3.8h5.1a4.4 4.4 0 01-1.9 2.9v2.4h3.1C20 17.6 21 15.1 21 12.2z" /><path d="M12 21c2.4 0 4.5-.8 6-2.2l-3.1-2.4c-.8.6-1.9.9-2.9.9-2.3 0-4.2-1.5-4.9-3.6H3.9v2.4A9 9 0 0012 21z" /><path d="M7.1 13.7a5.4 5.4 0 010-3.4V7.9H3.9a9 9 0 000 8.2z" /><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 003.9 7.9l3.2 2.4C7.8 8.1 9.7 6.6 12 6.6z" /></>),
  },
  {
    tag: "You hold the keys",
    t: "Non-custodial.",
    b: "Your funds are yours by design. Talise cannot move them for you, you are always in control.",
    bg: "#CAFFB8",
    icon: (<><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3" /><path d="M16 7l3 3" /><path d="M13 10l2.5 2.5" /></>),
  },
  {
    tag: "Private, never anonymous",
    t: "Quiet, not hidden.",
    b: "Your activity stays private to you. Compliant and above board, the way real money should be.",
    bg: "#C9B8FF",
    icon: (<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>),
  },
];

export function Trust() {
  const root = useReveal();
  return (
    <section ref={root} className="mx-auto max-w-[1400px] px-6 pt-20 pb-12 md:px-12 md:pt-24">
      <div className="mb-12 max-w-[820px]">
        <Eyebrow>Safe by design</Eyebrow>
        <h2 className="reveal text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
          Built to be{" "}
          <span className="relative inline-block">
            <span className="absolute inset-x-[-6px] inset-y-[5px] -z-0 -rotate-[1.5deg] rounded-[10px] bg-[#CAFFB8]" />
            <span className="relative z-10">trusted.</span>
          </span>
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {TRUST.map((c) => (
          <article key={c.tag} className="reveal relative rounded-[28px] p-7 md:p-8" style={{ background: c.bg, boxShadow: HARD }}>
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#15300c]/[0.08]">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#15300c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {c.icon}
              </svg>
            </span>
            <div className="mt-6 font-mono text-[11px] uppercase tracking-[0.22em] text-[#15300c]/65">{c.tag}</div>
            <h3 className="mt-2 text-[clamp(22px,2.6vw,28px)] font-[800] leading-[1.05] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
              {c.t}
            </h3>
            <p className="mt-3 text-[15px] leading-[1.5] text-[#15300c]/75">{c.b}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ============ APP SHOWCASE ============ */
export function AppShowcase() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context((self) => {
      gsap.registerPlugin(ScrollTrigger);
      const q = self.selector!;
      if (!reduce) {
        gsap.from(q(".reveal"), { opacity: 0, y: 20, duration: 0.7, stagger: 0.08, ease: "power2.out", scrollTrigger: { trigger: root.current, start: "top 80%" } });
        // gentle float on the phones
        gsap.to(q(".app-collage"), { y: -12, duration: 3.4, ease: "sine.inOut", yoyo: true, repeat: -1 });
      }
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} className="mx-auto max-w-[1200px] px-6 pt-20 pb-12 text-center md:px-12 md:pt-24">
      <div className="reveal mb-4 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">On TestFlight now</div>
      <h2 className="reveal mx-auto max-w-[820px] text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
        Save, send,{" "}
        <span className="relative inline-block">
          <span className="absolute inset-x-[-6px] inset-y-[5px] -z-0 -rotate-[1.5deg] rounded-[10px] bg-[#CAFFB8]" />
          <span className="relative z-10">done.</span>
        </span>
      </h2>
      <p className="reveal mx-auto mt-4 max-w-[440px] text-[16px] leading-[1.55] text-[#3a5230]">
        The whole flow, in a few taps. Put dollars to work, send to a name, and watch it land in under a second.
      </p>
      <div className="reveal relative mt-12">
        <div className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[68%] w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#CAFFB8]/45 blur-3xl" />
        <Image
          src="/talise-app-collage.png"
          alt="Talise app: a savings screen, reviewing a send to talise.sui, and a successful transfer"
          width={1200}
          height={639}
          priority
          className="app-collage mx-auto h-auto w-full max-w-[1000px] object-contain drop-shadow-[0_30px_50px_rgba(21,48,12,0.18)]"
        />
      </div>
    </section>
  );
}
