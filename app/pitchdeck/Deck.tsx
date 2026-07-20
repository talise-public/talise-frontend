"use client";

import { useCallback, useEffect, useState } from "react";

const TOTAL = 12;
const slides = Array.from(
  { length: TOTAL },
  (_, i) => `/pitchdeck/slide-${String(i + 1).padStart(2, "0")}.png`
);

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * Full-screen Talise pitch deck. Left/right (also space, PageUp/Down, Home/End,
 * swipe, click-zones) to navigate; slides cross-slide with a smooth transform.
 * Slides are pre-rendered PNGs in /public/pitchdeck.
 */
export default function Deck() {
  const [i, setI] = useState(0);
  const [hint, setHint] = useState(true);

  const go = useCallback(
    (d: number) => setI((x) => Math.max(0, Math.min(TOTAL - 1, x + d))),
    []
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", " ", "PageDown", "ArrowDown", "Enter"].includes(e.key)) {
        e.preventDefault();
        setHint(false);
        go(1);
      } else if (["ArrowLeft", "PageUp", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setHint(false);
        go(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setI(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setI(TOTAL - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Preload every slide so navigation is instant.
  useEffect(() => {
    slides.forEach((s) => {
      const im = new window.Image();
      im.src = s;
    });
  }, []);

  // Fade the navigation hint after a few seconds.
  useEffect(() => {
    const t = setTimeout(() => setHint(false), 4200);
    return () => clearTimeout(t);
  }, []);

  // Touch swipe (mobile).
  useEffect(() => {
    let x0: number | null = null;
    const start = (e: TouchEvent) => {
      x0 = e.touches[0]?.clientX ?? null;
    };
    const end = (e: TouchEvent) => {
      if (x0 == null) return;
      const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
      if (Math.abs(dx) > 45) {
        setHint(false);
        go(dx < 0 ? 1 : -1);
      }
      x0 = null;
    };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchend", end);
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchend", end);
    };
  }, [go]);

  const EASE = "cubic-bezier(.22,.61,.36,1)";

  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "#14170f",
        overflow: "hidden",
        fontFamily: MONO,
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* top progress bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: "rgba(255,255,255,0.08)",
          zIndex: 5,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${((i + 1) / TOTAL) * 100}%`,
            background: "#7fae5f",
            transition: `width .5s ${EASE}`,
          }}
        />
      </div>

      {/* sliding track */}
      <div
        style={{
          display: "flex",
          height: "100%",
          width: `${TOTAL * 100}vw`,
          transform: `translateX(-${i * 100}vw)`,
          transition: `transform .55s ${EASE}`,
          willChange: "transform",
        }}
      >
        {slides.map((src, idx) => (
          <div
            key={src}
            style={{
              width: "100vw",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "clamp(10px, 2.4vw, 46px)",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundImage: `url(${src})`,
                backgroundSize: "contain",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
                filter:
                  idx === i ? "drop-shadow(0 24px 64px rgba(0,0,0,0.5))" : "none",
                transition: "filter .4s ease",
              }}
            />
          </div>
        ))}
      </div>

      {/* click zones for presenting */}
      <button
        aria-label="Previous slide"
        onClick={() => {
          setHint(false);
          go(-1);
        }}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "32%",
          height: "100%",
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: i > 0 ? "w-resize" : "default",
          zIndex: 3,
        }}
      />
      <button
        aria-label="Next slide"
        onClick={() => {
          setHint(false);
          go(1);
        }}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: "50%",
          height: "100%",
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: i < TOTAL - 1 ? "e-resize" : "default",
          zIndex: 3,
        }}
      />

      {/* bottom control pill */}
      <div
        style={{
          position: "absolute",
          bottom: "clamp(14px, 3vh, 30px)",
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          zIndex: 4,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "rgba(20,23,15,0.72)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 999,
            padding: "8px 10px",
            pointerEvents: "auto",
          }}
        >
          <NavBtn dir="prev" disabled={i === 0} onClick={() => go(-1)} />
          <span
            style={{
              fontSize: 12,
              letterSpacing: "0.14em",
              color: "#cdd6c4",
              minWidth: 62,
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {String(i + 1).padStart(2, "0")} / {TOTAL}
          </span>
          <NavBtn dir="next" disabled={i === TOTAL - 1} onClick={() => go(1)} />
        </div>
      </div>

      {/* nav hint */}
      <div
        style={{
          position: "absolute",
          bottom: "clamp(14px, 3vh, 30px)",
          right: "clamp(16px, 3vw, 34px)",
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(205,214,196,0.6)",
          zIndex: 4,
          opacity: hint ? 1 : 0,
          transition: "opacity .6s ease",
          pointerEvents: "none",
        }}
      >
        ← → to navigate
      </div>
    </main>
  );
}

function NavBtn({
  dir,
  disabled,
  onClick,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Previous slide" : "Next slide"}
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        border: "1px solid rgba(255,255,255,0.14)",
        background: "transparent",
        color: disabled ? "rgba(205,214,196,0.3)" : "#e7ede0",
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 16,
        lineHeight: 1,
        padding: 0,
      }}
    >
      {dir === "prev" ? "‹" : "›"}
    </button>
  );
}
