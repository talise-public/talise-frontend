"use client";

/**
 * CoinBurst — the web port of the iOS send-success "coin drop" (Figma 141:18 /
 * SuccessfulTxView's `SuccessCoins` scrapbook entry).
 *
 * A small cluster of warm-gold coins drops in and scatters out, then settles
 * with a low-damping spring — the same "paper cutout pressed onto the page"
 * wobble as the iOS `scrapbookEntry` modifier. A soft mint bloom blooms behind
 * them and a few sparkles twinkle once. Tuned for the light-mint app theme:
 * coins are gold (#E8B23A) with a forest rim + mint highlight, sitting on the
 * white lifted cards — never gaudy, never cartoonish.
 *
 * Plays exactly once on mount, ~1.5s, then calls `onDone`. Self-contained SVG;
 * the mobile app's coin asset (public/anim/sui-coin.png). Respects prefers-reduced-motion (renders a single static,
 * already-settled coin and fires onDone immediately).
 */

import { useEffect } from "react";
import { motion, useReducedMotion, type Transition } from "framer-motion";

// ── Palette ────────────────────────────────────────────────────────────────
const MINT = "#caffb8"; // accent-light — bloom + sparkles (FILL only)

/** Sparkle positions around the cluster (px from center). */
const SPARKLES: Array<{ x: number; y: number; size: number; delay: number }> = [
  { x: -48, y: -30, size: 7, delay: 0.34 },
  { x: 50, y: -18, size: 9, delay: 0.42 },
  { x: 38, y: 30, size: 6, delay: 0.5 },
  { x: -44, y: 22, size: 5, delay: 0.46 },
];

// Low-damping spring → a visible 1–2 wobble settle, like the iOS scrapbook drop.
const settleSpring: Transition = { type: "spring", stiffness: 420, damping: 16, mass: 0.9 };

export function CoinBurst({
  onDone,
  size = 140,
}: {
  onDone?: () => void;
  /** Overall footprint of the cluster (px). */
  size?: number;
}) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!onDone) return;
    // Mirror the animation envelope so the parent can sequence follow-on UI.
    const t = window.setTimeout(onDone, reduce ? 0 : 1500);
    return () => window.clearTimeout(t);
  }, [onDone, reduce]);

  // Reduced motion: the already-settled coin pile. No drop, no scatter.
  if (reduce) {
    return (
      <div
        aria-hidden
        className="relative grid place-items-center"
        style={{ width: size, height: size }}
      >
        <CoinPile px={size * 0.92} />
      </div>
    );
  }

  const pilePx = size * 0.92;

  return (
    <div
      aria-hidden
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
    >
      {/* Soft mint bloom behind the coins — sets the stage, fades as they land. */}
      <motion.div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background: `radial-gradient(circle at 50% 52%, ${MINT}cc 0%, ${MINT}33 42%, transparent 70%)`,
          filter: "blur(8px)",
        }}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: [0, 0.9, 0.5], scale: [0.6, 1.08, 1] }}
        transition={{ duration: 1.1, times: [0, 0.4, 1], ease: [0.22, 1, 0.36, 1] }}
      />

      {/* The mobile app's coin-pile art drops in and settles with the same
          scrapbook wobble. (The old per-coin scatter rendered the iOS
          SuiCoinMark — pure WHITE on transparent — invisible on the light
          theme; the green SuccessCoins pile is the actual iOS success art.) */}
      <motion.div
        className="absolute"
        style={{ width: pilePx, willChange: "transform, opacity" }}
        initial={{ y: -54, scale: 1.16, rotate: 8, opacity: 0 }}
        animate={{ y: 4, scale: 1, rotate: 0, opacity: 1 }}
        transition={{ ...settleSpring, opacity: { duration: 0.2 } }}
      >
        <CoinPile px={pilePx} />
      </motion.div>

      {/* Sparkles — a brief one-shot twinkle once the pile has mostly settled. */}
      {SPARKLES.map((s, i) => (
        <motion.div
          key={`s-${i}`}
          className="pointer-events-none absolute"
          style={{ x: s.x, y: s.y }}
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: [0, 1, 0], scale: [0, 1, 0.4], rotate: [0, 90] }}
          transition={{ duration: 0.66, delay: s.delay, ease: "easeOut" }}
        >
          <Sparkle size={s.size} />
        </motion.div>
      ))}
    </div>
  );
}

/**
 * The mobile app's SuccessCoins pile (green halftone coin stacks) — the same
 * art iOS shows on SuccessfulTxView. NOT the SuiCoinMark (that asset is pure
 * white on transparent and disappears on the light theme).
 */
function CoinPile({ px }: { px: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/anim/success-coins.png"
      alt=""
      width={px}
      height={px}
      draggable={false}
      style={{ display: "block", width: px, height: "auto", objectFit: "contain" }}
    />
  );
}

/** A tiny four-point sparkle (mint), drawn as two crossed diamonds. */
function Sparkle({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z"
        fill={MINT}
      />
    </svg>
  );
}

export default CoinBurst;
