"use client";

import { useEffect } from "react";
import Lenis from "lenis";

/**
 * App-wide smooth (momentum) scrolling via Lenis. Mounted once in the app shell.
 *
 * Only the main window scroll is smoothed — any element (or ancestor) marked
 * `data-lenis-prevent` scrolls natively, so bottom sheets, dialogs, and the
 * perps terminal's inner panels keep their own scroll untouched. Honours
 * prefers-reduced-motion (falls back to native scroll).
 */
export default function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // syncTouch interpolates TOUCH scrolling too (not just the mouse wheel), so
    // phones get the same smooth momentum feel as desktop. A gentler lerp +
    // duration keeps it from fighting iOS's native rubber-banding.
    const lenis = new Lenis({
      duration: 1.05,
      smoothWheel: true,
      syncTouch: true,
      syncTouchLerp: 0.09,
      touchMultiplier: 1.2,
      anchors: true,
    });
    let id = requestAnimationFrame(function raf(time: number) {
      lenis.raf(time);
      id = requestAnimationFrame(raf);
    });

    return () => {
      cancelAnimationFrame(id);
      lenis.destroy();
    };
  }, []);

  return null;
}
