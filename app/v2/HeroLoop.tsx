"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";

/**
 * Hero centerpiece: a long, premium loop that walks through three Talise moves,
 * one scene at a time, then repeats.
 *
 *   Scene 1 - Send to a name : wallet lifts, a 3D coin pops, "sele@talise" types,
 *             a 3D plane flies the money along a dotted arc, recipient gets it.
 *   Scene 2 - Scan to pay    : a QR appears, a scan reticle + line sweep it,
 *             a "Paid" badge confirms.
 *   Scene 3 - Send a cheque  : a Talise cheque is written, a claim link flies
 *             along a dotted arc, the recipient claims it.
 *
 * Every move lands "in under a second". Dotted guide arcs + mint trails that
 * draw on give the illustrated feel. Respects prefers-reduced-motion by
 * rendering a single resolved frame of scene 1.
 */
const FEATURES = ["Send to a name", "Scan to pay", "Send a cheque"];

/** Stylised QR: three finder squares + scattered data cells in a 70x70 grid. */
function QrCode() {
  const data = [
    [30, 0], [50, 0], [30, 10], [60, 10], [30, 20], [40, 20], [0, 30], [10, 30],
    [30, 30], [50, 30], [60, 30], [30, 40], [40, 40], [60, 40], [30, 50], [50, 50],
    [60, 50], [40, 60], [50, 60], [60, 60],
  ];
  return (
    <svg viewBox="0 0 70 70" className="h-[150px] w-[150px]" aria-hidden>
      {/* finder squares */}
      {[[0, 0], [50, 0], [0, 50]].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width={20} height={20} rx={5} fill="none" stroke="#15300c" strokeWidth={4} />
          <rect x={x + 7} y={y + 7} width={6} height={6} rx={1.5} fill="#15300c" />
        </g>
      ))}
      {data.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={8} height={8} rx={2} fill="#15300c" />
      ))}
    </svg>
  );
}

export default function HeroLoop() {
  const root = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState(0);

  // The stage is authored at a fixed 440x470 design size; scale it to fit
  // whatever width it lands in (so the fixed-coordinate art never overflows on
  // mobile) and reserve the scaled height.
  useEffect(() => {
    const sizer = sizerRef.current;
    const stage = stageRef.current;
    if (!sizer || !stage) return;
    const fit = () => {
      const s = Math.min(1, sizer.clientWidth / 440);
      stage.style.transform = `scale(${s})`;
      sizer.style.height = `${470 * s}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(sizer);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context((self) => {
      const q = self.selector!;

      if (reduce) {
        setScene(0);
        gsap.set(q(".sc-send"), { opacity: 1, scale: 1 });
        gsap.set(q(".sc-scan, .sc-cheque"), { opacity: 0 });
        gsap.set(q(".s0-coin"), { opacity: 0 });
        gsap.set(q(".s0-typed"), { clipPath: "inset(0 0% 0 0)" });
        gsap.set(q(".s0-caret"), { opacity: 0 });
        gsap.set(q(".s0-plane"), { x: 150, y: 150, rotation: 26, opacity: 1 });
        gsap.set(q(".s0-trail"), { strokeDashoffset: 0 });
        gsap.set(q(".s0-recv"), { opacity: 1, y: 0, scale: 1 });
        gsap.set(q(".s0-check"), { scale: 1 });
        return;
      }

      const tl = gsap.timeline({ repeat: -1, defaults: { ease: "power3.out" } });

      // ---- reset (re-runs every loop) ----
      tl.set(q(".sc-send, .sc-scan, .sc-cheque"), { opacity: 0, scale: 0.98 })
        .set(q(".s0-card"), { y: 0 })
        .set(q(".s0-coin"), { x: 0, y: 0, scale: 0, opacity: 0, rotation: -25 })
        .set(q(".s0-typed"), { clipPath: "inset(0 100% 0 0)" })
        .set(q(".s0-caret"), { opacity: 0 })
        .set(q(".s0-plane"), { x: 0, y: 0, rotation: 16, opacity: 0 })
        .set(q(".s0-trail"), { strokeDashoffset: 100 })
        .set(q(".s0-recv"), { opacity: 0, y: 20, scale: 0.92 })
        .set(q(".s0-check"), { scale: 0 })
        .set(q(".s1-qr"), { opacity: 0, scale: 0.9 })
        .set(q(".s1-frame"), { opacity: 0, scale: 1.15 })
        .set(q(".s1-line"), { opacity: 0, y: -66 })
        .set(q(".s1-paid"), { opacity: 0, y: 16, scale: 0.9 })
        .set(q(".s1-check"), { scale: 0 })
        .set(q(".s2-cheque"), { opacity: 0, y: 26, scale: 0.94 })
        .set(q(".s2-amt"), { opacity: 0, y: 8 })
        .set(q(".s2-trail"), { strokeDashoffset: 100 })
        .set(q(".s2-link"), { x: 0, y: 0, opacity: 0, scale: 1 })
        .set(q(".s2-claim"), { opacity: 0, y: 16, scale: 0.9 })
        .set(q(".s2-check"), { scale: 0 });

      // ============ SCENE 1 - SEND TO A NAME ============
      tl.call(() => setScene(0))
        .to(q(".sc-send"), { opacity: 1, scale: 1, duration: 0.4 })
        .to(q(".s0-card"), { y: -6, duration: 0.5, ease: "power2.out" })
        .to(q(".s0-coin"), { opacity: 1, scale: 1, y: -42, rotation: 10, duration: 0.7, ease: "back.out(1.4)" }, "<")
        .to(q(".s0-coin"), { y: -34, duration: 0.35, ease: "sine.inOut" })
        .to(q(".s0-caret"), { opacity: 1, duration: 0.1 })
        .to(q(".s0-typed"), { clipPath: "inset(0 0% 0 0)", duration: 0.9, ease: "steps(11)" })
        .to(q(".s0-caret"), { opacity: 0, duration: 0.15, delay: 0.1 })
        .to(q(".s0-trail"), { strokeDashoffset: 0, duration: 1.0, ease: "power1.inOut" })
        .to(q(".s0-plane"), { opacity: 1, duration: 0.15 }, "<")
        .to(q(".s0-plane"), { keyframes: [{ x: 55, y: -34, rotation: 6 }, { x: 120, y: 30, rotation: 18 }, { x: 158, y: 150, rotation: 30 }], duration: 1.0, ease: "power1.inOut" }, "<")
        .to(q(".s0-coin"), { keyframes: [{ x: 55, y: -76 }, { x: 120, y: -4 }, { x: 158, y: 116, scale: 0.55, opacity: 0 }], duration: 1.0, ease: "power1.inOut" }, "<")
        .to(q(".s0-plane"), { opacity: 0, scale: 0.8, duration: 0.25 })
        .to(q(".s0-recv"), { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.5)" })
        .to(q(".s0-check"), { scale: 1, duration: 0.5, ease: "back.out(1.6)" }, "-=0.25")
        .to(q(".sc-send"), { opacity: 0, scale: 0.98, duration: 0.45 }, "+=1.0");

      // ============ SCENE 2 - SCAN TO PAY ============
      tl.call(() => setScene(1))
        .to(q(".sc-scan"), { opacity: 1, scale: 1, duration: 0.4 })
        .to(q(".s1-qr"), { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(1.6)" })
        .to(q(".s1-frame"), { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(1.4)" }, "-=0.15")
        .to(q(".s1-line"), { opacity: 1, duration: 0.12 })
        .to(q(".s1-line"), { y: 66, duration: 0.85, ease: "sine.inOut" })
        .set(q(".s1-line"), { y: -66 })
        .to(q(".s1-line"), { y: 66, duration: 0.85, ease: "sine.inOut" })
        .to(q(".s1-line"), { opacity: 0, duration: 0.15 }, "-=0.1")
        .to(q(".s1-qr"), { scale: 1.05, duration: 0.18, yoyo: true, repeat: 1 })
        .to(q(".s1-paid"), { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.6)" })
        .to(q(".s1-check"), { scale: 1, duration: 0.45, ease: "back.out(1.6)" }, "-=0.25")
        .to(q(".sc-scan"), { opacity: 0, scale: 0.98, duration: 0.45 }, "+=1.0");

      // ============ SCENE 3 - SEND A CHEQUE ============
      tl.call(() => setScene(2))
        .to(q(".sc-cheque"), { opacity: 1, scale: 1, duration: 0.4 })
        .to(q(".s2-cheque"), { opacity: 1, y: 0, scale: 1, duration: 0.55, ease: "back.out(1.5)" })
        .to(q(".s2-amt"), { opacity: 1, y: 0, duration: 0.4 }, "-=0.15")
        .to(q(".s2-trail"), { strokeDashoffset: 0, duration: 0.9, ease: "power1.inOut" }, "+=0.15")
        .to(q(".s2-link"), { opacity: 1, duration: 0.15 }, "<")
        .to(q(".s2-link"), { keyframes: [{ x: 44, y: -12, rotation: -6 }, { x: 120, y: 36, rotation: 4 }, { x: 168, y: 96, rotation: 10 }], duration: 0.95, ease: "power1.inOut" }, "<")
        .to(q(".s2-link"), { opacity: 0, scale: 0.8, duration: 0.2 })
        .to(q(".s2-claim"), { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.5)" })
        .to(q(".s2-check"), { scale: 1, duration: 0.45, ease: "back.out(1.6)" }, "-=0.25")
        .to(q(".sc-cheque"), { opacity: 0, scale: 0.98, duration: 0.45 }, "+=1.1");
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={root} className="v2-card relative mx-auto w-full min-w-0 max-w-[440px]">
      <div ref={sizerRef} className="relative w-full overflow-hidden">
      <div ref={stageRef} className="relative h-[470px] w-[440px] origin-top-left">
        {/* ============ SCENE 1 - SEND ============ */}
        <div className="sc-send absolute inset-0">
          <svg viewBox="0 0 440 470" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <path d="M 150 188 C 286 150, 372 232, 300 322" fill="none" stroke="#15300c" strokeOpacity="0.22" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="2 9" />
            <path className="s0-trail" d="M 150 188 C 286 150, 372 232, 300 322" fill="none" stroke="#3d7a29" strokeWidth="3" strokeLinecap="round" pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
          </svg>

          <div className="s0-card absolute left-0 top-3 w-[300px] overflow-hidden rounded-[28px] bg-gradient-to-br from-[#3d7a29] to-[#1c4513] p-7 text-[#f7fcf2]" style={{ boxShadow: "12px 12px 0 #15300c" }}>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#CAFFB8]">Your balance</div>
            <div className="mt-1.5 text-[38px] font-[800] leading-none" style={{ fontFamily: "var(--font-display-v2)" }}>$1,240.00</div>
            <div className="mt-1 font-mono text-[11px] text-[#cfe9c2]">1,240.00 USDsui</div>
            <div className="mt-5 rounded-2xl bg-[#0e2a08]/60 p-4">
              <div className="font-mono text-[10px] tracking-[0.12em] text-[#9fc78c]">SEND TO</div>
              <div className="mt-1 flex h-[24px] items-center">
                <span className="s0-typed inline-block overflow-hidden whitespace-nowrap text-[19px] font-semibold leading-none" style={{ clipPath: "inset(0 100% 0 0)" }}>sele@talise</span>
                <span className="s0-caret ml-[2px] inline-block h-[19px] w-[2px] bg-[#CAFFB8]" style={{ opacity: 0 }} />
              </div>
            </div>
          </div>

          <div className="s0-recv absolute bottom-4 right-[14px] w-[236px] rounded-[24px] bg-[#f7fcf2] p-5" style={{ boxShadow: "10px 10px 0 #15300c", border: "1.5px solid #15300c", opacity: 0 }}>
            <div className="flex items-center gap-3">
              <span className="s0-check flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3d7a29]" style={{ transform: "scale(0)" }}>
                <Check />
              </span>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#3d7a29]">Received</div>
                <div className="text-[20px] font-[800] leading-tight text-[#15300c]" style={{ fontFamily: "var(--font-display-v2)" }}>+$1,240.00</div>
              </div>
            </div>
            <div className="mt-3 font-mono text-[11px] text-[#3a5230]">landed in under a second · ada@talise</div>
          </div>

          <Image src="/v2/coin.png" alt="" width={72} height={72} className="s0-coin absolute left-[118px] top-[150px] h-[64px] w-[64px] object-contain drop-shadow-[0_8px_10px_rgba(21,48,12,0.25)]" style={{ opacity: 0, transform: "scale(0)" }} />
          <Image src="/v2/plane.png" alt="" width={96} height={96} className="s0-plane absolute left-[150px] top-[150px] h-[84px] w-[84px] object-contain drop-shadow-[0_10px_12px_rgba(21,48,12,0.25)]" style={{ opacity: 0 }} />
        </div>

        {/* ============ SCENE 2 - SCAN TO PAY ============ */}
        <div className="sc-scan absolute inset-0 flex flex-col items-center justify-center gap-7" style={{ opacity: 0 }}>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29]">Scan to pay · Corner Cafe</div>
          <div className="s1-qr relative rounded-[26px] bg-[#f7fcf2] p-7" style={{ boxShadow: "12px 12px 0 #15300c", border: "1.5px solid #15300c", opacity: 0 }}>
            <div className="relative overflow-hidden">
              <QrCode />
              <span className="s1-line absolute left-[-4px] right-[-4px] top-1/2 h-[3px] rounded-full bg-[#3d7a29]" style={{ opacity: 0, boxShadow: "0 0 12px 2px rgba(61,122,41,0.5)" }} />
            </div>
            {/* corner reticle */}
            <div className="s1-frame pointer-events-none absolute inset-3" style={{ opacity: 0 }}>
              {[["left-0 top-0 border-l-[3px] border-t-[3px] rounded-tl-[10px]"], ["right-0 top-0 border-r-[3px] border-t-[3px] rounded-tr-[10px]"], ["left-0 bottom-0 border-l-[3px] border-b-[3px] rounded-bl-[10px]"], ["right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-[10px]"]].map((c, i) => (
                <span key={i} className={`absolute h-6 w-6 border-[#3d7a29] ${c[0]}`} />
              ))}
            </div>
          </div>
          <div className="s1-paid flex items-center gap-3 rounded-full bg-[#15300c] px-5 py-2.5 text-[#f7fcf2]" style={{ opacity: 0 }}>
            <span className="s1-check flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8]" style={{ transform: "scale(0)" }}>
              <Check ink />
            </span>
            <span className="text-[15px] font-bold" style={{ fontFamily: "var(--font-display-v2)" }}>Paid $12.00</span>
          </div>
        </div>

        {/* ============ SCENE 3 - SEND A CHEQUE ============ */}
        <div className="sc-cheque absolute inset-0" style={{ opacity: 0 }}>
          <svg viewBox="0 0 440 470" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <path d="M 150 196 C 280 180, 360 250, 300 318" fill="none" stroke="#15300c" strokeOpacity="0.22" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="2 9" />
            <path className="s2-trail" d="M 150 196 C 280 180, 360 250, 300 318" fill="none" stroke="#3d7a29" strokeWidth="3" strokeLinecap="round" pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
          </svg>

          {/* the cheque */}
          <div className="s2-cheque absolute left-0 top-6 w-[300px] overflow-hidden rounded-[24px] bg-[#FFE59E] p-6 text-[#15300c]" style={{ boxShadow: "12px 12px 0 #15300c", border: "1.5px solid #15300c", opacity: 0 }}>
            <div className="flex items-center justify-between">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#15300c]/70">Talise cheque</div>
              <span className="rounded-full bg-[#15300c] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[#FFE59E]">claimable</span>
            </div>
            <div className="s2-amt mt-3 text-[42px] font-[800] leading-none" style={{ fontFamily: "var(--font-display-v2)", opacity: 0 }}>$50.00</div>
            <div className="mt-4 border-t border-dashed border-[#15300c]/40 pt-3 font-mono text-[12px] tracking-[0.08em]">TLS-7F2K-9QX</div>
            <div className="mt-1 font-mono text-[11px] text-[#15300c]/65">anyone with the link can claim</div>
          </div>

          {/* recipient claim */}
          <div className="s2-claim absolute bottom-5 right-[14px] w-[232px] rounded-[24px] bg-[#f7fcf2] p-5" style={{ boxShadow: "10px 10px 0 #15300c", border: "1.5px solid #15300c", opacity: 0 }}>
            <div className="flex items-center gap-3">
              <span className="s2-check flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3d7a29]" style={{ transform: "scale(0)" }}>
                <Check />
              </span>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#3d7a29]">Claimed</div>
                <div className="text-[20px] font-[800] leading-tight text-[#15300c]" style={{ fontFamily: "var(--font-display-v2)" }}>+$50.00</div>
              </div>
            </div>
            <div className="mt-3 font-mono text-[11px] text-[#3a5230]">claimed in under a second</div>
          </div>

          {/* flying claim link */}
          <div className="s2-link absolute left-[150px] top-[176px] flex items-center gap-1.5 rounded-full bg-[#15300c] px-3.5 py-2 text-[#f7fcf2]" style={{ opacity: 0, boxShadow: "4px 4px 0 rgba(21,48,12,0.4)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#CAFFB8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 15 l6-6 M10.5 6.5 l1.8-1.8 a4 4 0 0 1 5.7 5.7 l-1.8 1.8 M13.5 17.5 l-1.8 1.8 a4 4 0 0 1-5.7-5.7 l1.8-1.8" />
            </svg>
            <span className="font-mono text-[11px] font-medium">claim link</span>
          </div>
        </div>
      </div>
      </div>

      {/* feature tabs */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
        {FEATURES.map((f, i) => (
          <div key={f} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full transition-all duration-300" style={{ background: scene === i ? "#15300c" : "rgba(21,48,12,0.2)", transform: scene === i ? "scale(1.35)" : "scale(1)" }} />
            <span className="font-mono text-[11px] transition-colors duration-300" style={{ color: scene === i ? "#15300c" : "rgba(21,48,12,0.4)" }}>{f}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Check({ ink = false }: { ink?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ink ? "#15300c" : "#f7fcf2"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5 l4.5 4.5 L19 6.5" />
    </svg>
  );
}
