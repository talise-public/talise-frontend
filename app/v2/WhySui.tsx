"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

type IconName = "bolt" | "coin" | "shield";
type Card = { tag: string; title: string; body: string; bg: string; icon: IconName; tilt: string };

const CARDS: Card[] = [
  {
    tag: "Instant",
    title: "Settles in a blink.",
    body: "Transfers clear on Sui the moment you tap send, so your money lands in under a second, not days.",
    bg: "#FF9E7A",
    icon: "bolt",
    tilt: "-1.5deg",
  },
  {
    tag: "Costs nothing",
    title: "Costs nothing to move.",
    body: "Stablecoin transactions on Sui cost nothing, send a dollar or a thousand, the amount lands whole.",
    bg: "#C9B8FF",
    icon: "coin",
    tilt: "1.4deg",
  },
  {
    tag: "Gas, sponsored",
    title: "We cover the gas.",
    body: "Talise pays the network gas on every move. You never hold it, never top it up, never even see it.",
    bg: "#FFE59E",
    icon: "shield",
    tilt: "-1.1deg",
  },
];

/** Clean inline-SVG icons (no emoji) drawn in ink, sized for the card chip. */
function Icon({ name }: { name: IconName }) {
  const common = { width: 26, height: 26, viewBox: "0 0 24 24", fill: "none", stroke: "#15300c", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#15300c]/[0.08]">
      {name === "bolt" && (
        <svg {...common}><path d="M13 2 L4.5 13.5 H11 l-1 8.5 L19.5 10 H13 z" fill="#15300c" stroke="none" /></svg>
      )}
      {name === "coin" && (
        <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7.5 v9 M14.4 9.2 c-.7-.8-3.9-1.2-4.4.4-.5 1.7 4.4 1.2 4.4 3 0 1.6-3.7 1.4-4.6.3" /></svg>
      )}
      {name === "shield" && (
        <svg {...common}><path d="M12 2.5 l8 3 v5.5 c0 5-3.6 8-8 9.5-4.4-1.5-8-4.5-8-9.5 V5.5 z" /><path d="M8.5 12 l2.3 2.3 L15.5 9.5" /></svg>
      )}
    </span>
  );
}

/**
 * v2 "Why Sui" / trust beat, the rails finally match the promise.
 * Bricolage headline word-reveal + mint highlighter swipe, then a row of three
 * bento cards (coral / lilac / butter, hard offset shadow, slight tilt) that pop
 * in on scroll. Respects prefers-reduced-motion.
 */
export default function WhySui() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context((self) => {
      gsap.registerPlugin(ScrollTrigger);
      const q = self.selector!;
      gsap.set(q(".ws-hl"), { scaleX: 0, transformOrigin: "left center" });
      gsap
        .timeline({ scrollTrigger: { trigger: root.current, start: "top 78%" } })
        .from(q(".ws-head .v2-word"), { opacity: 0, y: 20, duration: 0.7, stagger: 0.07, ease: "power2.out" })
        .to(q(".ws-hl"), { scaleX: 1, duration: 0.5, ease: "power2.out" }, "-=0.25")
        .from(q(".ws-card"), { opacity: 0, y: 22, duration: 0.7, stagger: 0.09, ease: "power2.out" }, "-=0.2");
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} className="mx-auto max-w-[1400px] px-6 pt-20 pb-28 md:px-12 md:pt-28">
      <div className="ws-head mb-14 max-w-[820px]">
        <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">Built on Sui</div>
        <h2 className="text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em]" style={{ fontFamily: "var(--font-display-v2)" }}>
          <span className="block overflow-hidden pb-[0.06em]"><span className="v2-word inline-block">The rails finally</span></span>
          <span className="relative inline-block">
            <span className="ws-hl absolute inset-x-[-8px] inset-y-[6px] -z-0 -rotate-[1.2deg] rounded-[12px] bg-[#CAFFB8]" />
            <span className="v2-word relative z-10 inline-block">match the promise.</span>
          </span>
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {CARDS.map((c) => (
          <article
            key={c.tag}
            className="ws-card relative overflow-hidden rounded-[28px] p-7 md:p-9"
            style={{ background: c.bg, boxShadow: "10px 10px 0 #15300c", transform: `rotate(${c.tilt})` }}
          >
            <div className="flex items-start justify-between">
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#15300c]/70">{c.tag}</div>
              <Icon name={c.icon} />
            </div>
            <h3 className="mt-6 text-[clamp(24px,3vw,32px)] font-[800] leading-[1.02] tracking-[-0.02em] text-[#15300c]" style={{ fontFamily: "var(--font-display-v2)" }}>
              {c.title}
            </h3>
            <p className="mt-3 max-w-[320px] text-[15px] leading-[1.5] text-[#15300c]/75">{c.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
