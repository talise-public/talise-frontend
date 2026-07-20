"use client";

import { useEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

/**
 * Landing motion controller (GSAP + ScrollTrigger + Lenis). Mounted once at the
 * root of the v3 landing. Drives three things:
 *
 *  1. Smooth momentum scrolling (Lenis), driven off the GSAP ticker so the
 *     reveals stay perfectly in sync with the smoothed scroll position.
 *  2. Section flow, every `.v3-reveal` rises + fades in as it enters the
 *     viewport.
 *  3. Micro-animations inside the product mock widgets, balance bars grow,
 *     figures count up, the slide-to-send handle nudges, corridor rows stagger.
 *
 * Honours prefers-reduced-motion (everything is shown immediately, native
 * scroll, no motion). `.v3-reveal` starts hidden in CSS, so if this never runs
 * the media-query fallback in v3.css keeps content visible.
 */
export default function Motion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".landing-v3");
    if (!root) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      root.querySelectorAll<HTMLElement>(".v3-reveal").forEach((el) => {
        el.style.opacity = "1";
        el.style.transform = "none";
      });
      return;
    }

    gsap.registerPlugin(ScrollTrigger);

    // Smooth scroll on every device. syncTouch interpolates TOUCH scrolling too
    // (not just the mouse wheel), so phones get the same smooth momentum as
    // desktop; a gentle lerp keeps it from fighting iOS rubber-banding. anchors
    // keeps the in-page nav links smooth.
    const lenis = new Lenis({
      duration: 1.05,
      smoothWheel: true,
      syncTouch: true,
      syncTouchLerp: 0.09,
      touchMultiplier: 1.2,
      anchors: true,
    });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    const ctx = gsap.context(() => {
      // ── Section flow: each block rises + fades as it enters ────────────────
      // Per-element triggers (not batch) so blocks already in view at load
      // reveal deterministically; fromTo's immediateRender sets the hidden
      // start state before first paint, so there's no flash.
      gsap.utils.toArray<HTMLElement>(".v3-reveal").forEach((el) => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 22 },
          {
            opacity: 1,
            y: 0,
            duration: 0.8,
            ease: "power3.out",
            scrollTrigger: { trigger: el, start: "top 88%", once: true },
          },
        );
      });

      // ── Micro: balance / earnings bars grow up ────────────────────────────
      gsap.utils.toArray<HTMLElement>("[data-bars]").forEach((wrap) => {
        const bars = wrap.querySelectorAll<HTMLElement>("[data-bar]");
        gsap.fromTo(
          bars,
          { scaleY: 0 },
          {
            scaleY: 1,
            transformOrigin: "bottom",
            duration: 0.7,
            ease: "power2.out",
            stagger: 0.055,
            scrollTrigger: { trigger: wrap, start: "top 85%", once: true },
          },
        );
      });

      // ── Micro: figures count up ───────────────────────────────────────────
      gsap.utils.toArray<HTMLElement>("[data-countup]").forEach((el) => {
        const end = parseFloat(el.dataset.countup || "0");
        if (!Number.isFinite(end)) return;
        const obj = { v: 0 };
        gsap.to(obj, {
          v: end,
          duration: 1.2,
          ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 90%", once: true },
          onUpdate: () => {
            el.textContent = Math.round(obj.v).toLocaleString("en-US");
          },
        });
      });

      // ── Micro: slide-to-send handle nudge (gentle loop) ───────────────────
      gsap.utils.toArray<HTMLElement>("[data-slide]").forEach((el) => {
        gsap.to(el, { x: 7, duration: 0.95, ease: "sine.inOut", repeat: -1, yoyo: true });
      });

      // ── Micro: corridor rows stagger in ───────────────────────────────────
      gsap.utils.toArray<HTMLElement>("[data-rows]").forEach((wrap) => {
        const rows = wrap.querySelectorAll<HTMLElement>("[data-row]");
        gsap.from(rows, {
          opacity: 0,
          y: 12,
          duration: 0.6,
          ease: "power2.out",
          stagger: 0.1,
          scrollTrigger: { trigger: wrap, start: "top 84%", once: true },
        });
      });
    }, root);

    // Recompute trigger positions once now, and again once late assets (the
    // hero collage, flags) finish loading and shift the layout.
    ScrollTrigger.refresh();
    const onLoad = () => ScrollTrigger.refresh();
    window.addEventListener("load", onLoad);

    return () => {
      window.removeEventListener("load", onLoad);
      gsap.ticker.remove(tick);
      lenis.destroy();
      ctx.revert();
    };
  }, []);

  return null;
}
