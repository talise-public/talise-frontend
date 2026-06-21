"use client";

import { useEffect, useRef } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import HeroLoop from "./HeroLoop";

const TESTFLIGHT_URL = "https://testflight.apple.com/join/BFNEPYtM";

/**
 * v2 hero, bold, playful, type-driven (Wero-inspired) in Talise mint brand.
 * Giant Bricolage headline that clip-reveals word-by-word, a mint highlighter
 * swipe on the key phrase, a hero bento card, and the floating pill nav.
 * Initialises Lenis smooth scroll for the whole v2 page.
 */
export default function HeroV2() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Lenis smooth scroll for the page
    let lenis: Lenis | null = null;
    if (!reduce) {
      gsap.registerPlugin(ScrollTrigger);
      lenis = new Lenis({ lerp: 0.1, smoothWheel: true, anchors: true });
      lenis.on("scroll", ScrollTrigger.update);
      const onRaf = (t: number) => lenis!.raf(t * 1000);
      gsap.ticker.add(onRaf);
      gsap.ticker.lagSmoothing(0);
    }

    const ctx = gsap.context((self) => {
      const q = self.selector!;
      if (reduce) {
        gsap.set(q(".v2-word, .v2-anim"), { opacity: 1, y: 0, yPercent: 0 });
        gsap.set(q(".v2-hl"), { scaleX: 1 });
        gsap.set(q(".v2-card"), { opacity: 1, y: 0 });
        return;
      }
      gsap.set(q(".v2-hl"), { scaleX: 0, transformOrigin: "left center" });
      const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
      tl.from(q(".v2-eyebrow"), { opacity: 0, y: 10, duration: 0.5 })
        .from(q(".v2-word"), { opacity: 0, y: 20, duration: 0.7, stagger: 0.08 }, "-=0.15")
        .to(q(".v2-hl"), { scaleX: 1, duration: 0.5, ease: "power2.out" }, "-=0.3")
        .from(q(".v2-sub"), { opacity: 0, y: 12, duration: 0.6 }, "-=0.45")
        // Animate the CTA ROW as one unit (not each button). The "Get the app"
        // button carries `transition-transform` for its hover lift, which fights
        // a GSAP `y` tween on the button itself and freezes it 12px low. Moving
        // the transform to the wrapper keeps both buttons perfectly aligned.
        .from(q(".v2-cta-row"), { opacity: 0, y: 12, duration: 0.5 }, "-=0.4")
        .from(q(".v2-card"), { opacity: 0, y: 24, duration: 0.8, ease: "power2.out" }, "-=0.55")
        .from(q(".v2-nav"), { opacity: 0, y: 16, duration: 0.6 }, "-=0.5");
    }, root);

    return () => {
      ctx.revert();
      lenis?.destroy();
    };
  }, []);

  return (
    <div ref={root}>
      <section className="mx-auto grid grid-cols-1 max-w-[1500px] items-center gap-12 px-6 pt-24 pb-16 md:px-12 lg:grid-cols-[1.15fr_1fr] lg:pt-28">
        {/* copy */}
        <div>
          <div className="v2-eyebrow mb-6 inline-flex items-center gap-2 rounded-full border border-[#15300c]/15 bg-white/60 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[#3d7a29] backdrop-blur-sm">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#3d7a29]" /> Dollars, on Sui
          </div>

          <h1
            className="text-[clamp(33px,7.8vw,104px)] font-[800] uppercase leading-[0.92] tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display-v2)" }}
          >
            <Line>Money that</Line>
            <Line>moves like a</Line>
            <span className="relative mt-1 inline-block overflow-visible">
              <span className="v2-hl absolute inset-x-[-8px] inset-y-[6px] -z-0 -rotate-[1.5deg] rounded-[14px] bg-[#CAFFB8]" />
              <span className="v2-word relative z-10 inline-block">message.</span>
            </span>
          </h1>

          <p className="v2-sub mt-7 max-w-[460px] text-[17px] leading-[1.55] text-[#3a5230]">
            Hold real dollars, send them to a name, cash out at home. No seed
            phrase, no gas to think about, money that finally makes sense.
          </p>

          <div className="v2-cta-row mt-9 grid w-full max-w-[420px] grid-cols-2 gap-3">
            <a
              href={TESTFLIGHT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="v2-cta flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[#15300c] px-4 text-[15px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5"
            >
              Get the app
              <span aria-hidden>↗</span>
            </a>
            <a
              href="/waitlist"
              className="v2-cta flex h-[52px] w-full items-center justify-center rounded-full border-2 border-[#15300c] px-4 text-[15px] font-semibold text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
            >
              How it works
            </a>
          </div>
        </div>

        {/* animated 4-step money-movement loop */}
        <HeroLoop />
      </section>

      {/* floating pill nav */}
      <nav className="v2-nav pointer-events-auto fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-full border border-[#15300c]/10 bg-white/85 px-2 py-2 shadow-[0_10px_40px_-12px_rgba(21,48,12,0.35)] backdrop-blur-md">
        <div className="hidden items-center gap-1 sm:flex">
          {[
            { l: "How it works", href: "#start" },
            { l: "Features", href: "#features" },
            { l: "Global", href: "#how" },
            { l: "Earn", href: "#earn" },
            { l: "FAQ", href: "#faq" },
          ].map((n) => (
            <a key={n.l} href={n.href} className="rounded-full px-3.5 py-2 text-[14px] font-medium text-[#15300c] transition-colors hover:bg-[#15300c]/[0.06]">
              {n.l}
            </a>
          ))}
        </div>
        <a href={TESTFLIGHT_URL} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[#15300c] px-5 py-2 text-[14px] font-semibold text-[#f7fcf2] sm:ml-1">
          Get the app
        </a>
      </nav>
    </div>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <span className="block overflow-hidden pb-[0.06em]">
      <span className="v2-word inline-block">{children}</span>
    </span>
  );
}
