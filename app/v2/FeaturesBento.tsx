"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

type Card = { tag: string; title: string; body: string; bg: string; img: string; tilt: string };

const CARDS: Card[] = [
  { tag: "Hold", title: "Hold real dollars.", body: "Genuine US dollars on Sui, yours to hold, spend, or send, any time.", bg: "#CAFFB8", img: "/v2/coin.png", tilt: "-1.5deg" },
  { tag: "Send", title: "Send to a name.", body: "Type sele@talise, hit send, it lands in under a second. Stablecoin transactions on Sui cost nothing.", bg: "#FF9E7A", img: "/v2/plane.png", tilt: "1.5deg" },
  { tag: "Earn", title: "Idle money grows.", body: "Sitting still? Talise quietly puts it to work, auto-routed, and always yours to move.", bg: "#C9B8FF", img: "/v2/sprout.png", tilt: "1.2deg" },
  { tag: "Cash out", title: "Cash out at home.", body: "Turn dollars into your local currency, or wire USD to your bank. Enter an amount, withdraw.", bg: "#FFE59E", img: "/v2/phone.png", tilt: "-1.2deg" },
];

export default function FeaturesBento() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context((self) => {
      gsap.registerPlugin(ScrollTrigger);
      const q = self.selector!;
      gsap.set(q(".fb-hl"), { scaleX: 0, transformOrigin: "left center" });
      gsap
        .timeline({ scrollTrigger: { trigger: root.current, start: "top 78%" } })
        .from(q(".fb-head .v2-word"), { opacity: 0, y: 20, duration: 0.7, stagger: 0.07, ease: "power2.out" })
        .to(q(".fb-hl"), { scaleX: 1, duration: 0.5, ease: "power2.out" }, "-=0.25")
        .from(q(".fb-card"), { opacity: 0, y: 22, duration: 0.7, stagger: 0.09, ease: "power2.out" }, "-=0.2");
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} className="mx-auto max-w-[1400px] px-6 pt-20 pb-28 md:px-12 md:pt-28">
      <div className="fb-head mb-14 text-center">
        <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">What you get</div>
        <h2 className="text-[clamp(25px,5.6vw,60px)] font-[800] uppercase leading-[0.98] tracking-[-0.02em]" style={{ fontFamily: "var(--font-display-v2)" }}>
          <span className="block overflow-hidden pb-[0.06em]"><span className="v2-word inline-block">Everything money</span></span>
          <span className="relative inline-block">
            <span className="fb-hl absolute inset-x-[-8px] inset-y-[6px] -z-0 -rotate-[1.2deg] rounded-[12px] bg-[#CAFFB8]" />
            <span className="v2-word relative z-10 inline-block">should already do.</span>
          </span>
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {CARDS.map((c) => (
          <article
            key={c.tag}
            className="fb-card relative overflow-hidden rounded-[28px] p-7 md:p-9"
            style={{ background: c.bg, boxShadow: "10px 10px 0 #15300c", transform: `rotate(${c.tilt})` }}
          >
            <div className="flex items-start justify-between">
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#15300c]/70">{c.tag}</div>
              <Image
                src={c.img}
                alt=""
                width={140}
                height={140}
                className="-mr-3 -mt-3 h-[104px] w-[104px] object-contain drop-shadow-[0_10px_12px_rgba(21,48,12,0.22)]"
              />
            </div>
            <h3 className="mt-6 text-[clamp(24px,3vw,34px)] font-[800] leading-[1.02] tracking-[-0.02em] text-[#15300c]" style={{ fontFamily: "var(--font-display-v2)" }}>
              {c.title}
            </h3>
            <p className="mt-3 max-w-[360px] text-[15px] leading-[1.5] text-[#15300c]/75">{c.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
