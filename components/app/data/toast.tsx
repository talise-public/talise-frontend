"use client";

/**
 * Lightweight toast system. <ToastProvider> is mounted by AppShell; any
 * client component calls `useToast().toast(msg, tone)` to surface a brief
 * glass pill at the bottom of the screen. Tones map to the brand mint
 * (success), danger red, or a neutral hairline.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Cancel01Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";

export type ToastTone = "success" | "danger" | "neutral";
type ToastItem = { id: number; message: string; tone: ToastTone };

type ToastCtx = { toast: (message: string, tone?: ToastTone) => void };

const Ctx = createContext<ToastCtx | null>(null);

const TONE_ICON = {
  success: CheckmarkCircle02Icon,
  danger: Cancel01Icon,
  neutral: InformationCircleIcon,
} as const;

const TONE_COLOR = {
  success: "#3d7a29",
  danger: "#c0532f",
  neutral: "#3a5230",
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback((message: string, tone: ToastTone = "neutral") => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[120] flex flex-col items-center gap-2 px-4 lg:bottom-8"
        aria-live="polite"
        aria-atomic="false"
      >
        {/* v2 toast pill: this stack renders OUTSIDE the themed page wrapper,
            so it carries its own explicit colors (cream pill, ink text) rather
            than inheriting any root tokens. */}
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className="talise-toast-in pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-full border border-[#15300c]/12 bg-[#f7fcf2] px-4 py-2.5 text-sm text-[#15300c] shadow-[0_10px_40px_-12px_rgba(21,48,12,0.45)] sm:max-w-md"
            style={{ borderRadius: 999 }}
          >
            <HugeiconsIcon
              icon={TONE_ICON[t.tone]}
              size={18}
              color={TONE_COLOR[t.tone]}
              strokeWidth={2}
            />
            <span className="truncate font-medium">{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider> (mounted by AppShell)");
  }
  return ctx;
}
