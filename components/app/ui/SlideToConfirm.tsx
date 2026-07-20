"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Spinner } from "./Spinner";

export type SlideToConfirmProps = {
  label: string;
  onConfirm: () => Promise<void> | void;
  /** Accent fill behind the track + knob. Default forest green (#3d7a29). */
  tint?: string;
  disabled?: boolean;
  /** Bump this number to force the slider back to its rest position. */
  resetSignal?: number;
};

const TRACK_HEIGHT = 58;
const THRESHOLD = 0.8;

/**
 * Drag-to-confirm capsule. The user drags the knob from left to right; once
 * past 80% of the track it commits and runs `onConfirm`. Springs back if
 * released early. Shows a spinner while pending and a checkmark on success,
 * with a haptic buzz where supported. Pointer events cover mouse + touch.
 */
export function SlideToConfirm({
  label,
  onConfirm,
  tint = "#3d7a29",
  disabled = false,
  resetSignal = 0,
}: SlideToConfirmProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [maxX, setMaxX] = useState(0);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const startRef = useRef(0);
  const pointerStartRef = useRef(0);

  const knob = TRACK_HEIGHT - 8;

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setMaxX(Math.max(0, el.clientWidth - knob - 8));
  }, [knob]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, [measure]);

  // External reset.
  useEffect(() => {
    setX(0);
    setDone(false);
    setPending(false);
    setDragging(false);
  }, [resetSignal]);

  const commit = useCallback(async () => {
    setPending(true);
    setX(maxX);
    try {
      await onConfirm();
      setDone(true);
      try {
        navigator.vibrate?.(30);
      } catch {
        /* unsupported */
      }
    } catch {
      // Failed, spring back so the user can retry. The caller surfaces the
      // error message separately.
      setX(0);
    } finally {
      setPending(false);
    }
  }, [maxX, onConfirm]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || pending || done) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      pointerStartRef.current = e.clientX;
      startRef.current = x;
      setDragging(true);
    },
    [disabled, pending, done, x]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - pointerStartRef.current;
      const next = Math.min(maxX, Math.max(0, startRef.current + dx));
      setX(next);
    },
    [dragging, maxX]
  );

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (maxX > 0 && x / maxX >= THRESHOLD) {
      void commit();
    } else {
      setX(0); // spring back
    }
  }, [dragging, maxX, x, commit]);

  const progress = maxX > 0 ? x / maxX : 0;

  return (
    <div
      ref={trackRef}
      className="talise-noselect relative w-full overflow-hidden border border-[#15300c]/15 bg-white/60 backdrop-blur-sm"
      style={{
        height: TRACK_HEIGHT,
        borderRadius: 999,
        opacity: disabled ? 0.5 : 1,
        touchAction: "none",
      }}
      aria-disabled={disabled}
    >
      {/* Progress fill, soft-mint wash that deepens toward the forest knob. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{
          width: x + knob + 8,
          background: `color-mix(in srgb, ${tint} 18%, #ffffff)`,
          borderRadius: 999,
          transition: dragging ? "none" : "width 320ms cubic-bezier(0.22,1,0.36,1)",
        }}
      />
      {/* Label */}
      <span
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-[15px] font-semibold text-[#3a5230]"
        style={{ opacity: 1 - progress * 0.9, letterSpacing: "-0.05em" }}
      >
        {done ? "Confirmed" : pending ? "Sending…" : label}
      </span>
      {/* Knob */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled || pending || done) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void commit();
          }
        }}
        className="absolute top-1/2 flex cursor-grab items-center justify-center rounded-full active:cursor-grabbing"
        style={{
          left: 4,
          width: knob,
          height: knob,
          transform: `translate(${x}px, -50%)`,
          background: tint,
          color: "#f7fcf2",
          boxShadow: "0 6px 18px -6px rgba(21,48,12,0.55)",
          transition: dragging ? "none" : "transform 320ms cubic-bezier(0.22,1,0.36,1)",
          touchAction: "none",
        }}
      >
        {done ? (
          <HugeiconsIcon icon={Tick02Icon} size={22} color="#f7fcf2" strokeWidth={2.5} />
        ) : pending ? (
          <Spinner size={20} />
        ) : (
          <HugeiconsIcon icon={ArrowRight01Icon} size={22} color="#f7fcf2" strokeWidth={2.5} />
        )}
      </div>
    </div>
  );
}
