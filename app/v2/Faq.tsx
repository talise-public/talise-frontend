"use client";

import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

type Item = { q: string; a: string; bg: string; tilt: string };

const ITEMS: Item[] = [
  {
    q: "Do I need a crypto wallet?",
    a: "Sign in with Google, that's your wallet. No seed phrase, nothing to install.",
    bg: "#CAFFB8",
    tilt: "-1.2deg",
  },
  {
    q: "Is it real dollars?",
    a: "Yes, genuine US dollars on Sui (USDsui), 1:1.",
    bg: "#FFE59E",
    tilt: "1.2deg",
  },
  {
    q: "How fast are transfers?",
    a: "They land in under a second, Sui finalizes that fast. Stablecoin transactions on Sui cost nothing.",
    bg: "#FF9E7A",
    tilt: "-1deg",
  },
  {
    q: "How do I cash out?",
    a: "To your local currency, or wire USD to your bank, enter an amount and withdraw.",
    bg: "#C9B8FF",
    tilt: "1.4deg",
  },
];

/**
 * v2 FAQ, playful Bricolage headline with a mint highlighter swipe, then five
 * bento-card accordion rows (each a complementary gradient, hard offset shadow,
 * slight tilt). GSAP ScrollTrigger reveals the headline word-by-word, swipes the
 * highlighter, and pops the cards in with stagger. Respects reduced-motion.
 */
export default function Faq() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context((self) => {
      gsap.registerPlugin(ScrollTrigger);
      const q = self.selector!;
      gsap.set(q(".faq-hl"), { scaleX: 0, transformOrigin: "left center" });
      gsap
        .timeline({ scrollTrigger: { trigger: root.current, start: "top 78%" } })
        .from(q(".faq-head .v2-word"), { opacity: 0, y: 20, duration: 0.7, stagger: 0.07, ease: "power2.out" })
        .to(q(".faq-hl"), { scaleX: 1, duration: 0.5, ease: "power2.out" }, "-=0.25")
        .from(q(".faq-card"), { opacity: 0, y: 20, duration: 0.65, stagger: 0.08, ease: "power2.out" }, "-=0.2");
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} className="mx-auto max-w-[900px] px-6 pt-20 pb-28 md:px-12 md:pt-28">
      <div className="faq-head mb-12 text-center">
        <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">The honest answers</div>
        <h2
          className="text-[clamp(28px,6.4vw,72px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          <span className="inline-block overflow-hidden pb-[0.06em] align-bottom">
            <span className="v2-word inline-block">Questions?&nbsp;</span>
          </span>
          <span className="relative inline-block align-bottom">
            <span className="faq-hl absolute inset-x-[-10px] inset-y-[8px] -z-0 -rotate-[1.5deg] rounded-[14px] bg-[#CAFFB8]" />
            <span className="v2-word relative z-10 inline-block">Good.</span>
          </span>
        </h2>
      </div>

      <div className="flex flex-col gap-5">
        {ITEMS.map((item, i) => {
          const isOpen = open === i;
          return (
            <article
              key={item.q}
              className="faq-card overflow-hidden rounded-[28px]"
              style={{ background: item.bg, boxShadow: "10px 10px 0 #15300c", transform: `rotate(${item.tilt})` }}
            >
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 px-7 py-6 text-left md:px-9"
              >
                <span
                  className="text-[clamp(19px,2.4vw,26px)] font-[800] leading-[1.05] tracking-[-0.02em] text-[#15300c]"
                  style={{ fontFamily: "var(--font-display-v2)" }}
                >
                  {item.q}
                </span>
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#15300c] text-[20px] font-[800] leading-none text-[#f7fcf2] transition-transform duration-300"
                  style={{ transform: isOpen ? "rotate(45deg)" : "rotate(0deg)" }}
                  aria-hidden
                >
                  +
                </span>
              </button>
              <div
                className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
                style={{ gridTemplateRows: isOpen ? "1fr" : "0fr", opacity: isOpen ? 1 : 0 }}
              >
                <div className="overflow-hidden">
                  <p className="px-7 pb-7 text-[16px] leading-[1.55] text-[#15300c]/80 md:px-9">{item.a}</p>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <p className="mt-12 text-center font-mono text-[12px] tracking-[0.04em] text-[#3a5230]">
        Still curious? Find us on{" "}
        <a href="https://x.com/taliseio" target="_blank" rel="noreferrer noopener" className="text-[#15300c] underline-offset-2 hover:underline">
          X @taliseio
        </a>
        .
      </p>
    </section>
  );
}
