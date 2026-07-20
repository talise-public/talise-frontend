"use client";

/**
 * Shared "hide amounts" toggle. When on, sensitive figures across the app
 * (the Home balance, activity amounts, the full Activity page) render as a
 * masked placeholder instead of the real number. DISPLAY-ONLY, this never
 * touches form inputs, send amounts, or any money/limit path.
 *
 * State lives in localStorage ("talise:amounts-hidden") so the choice sticks
 * across reloads, and is synced live across components in the same tab via a
 * custom window event, and across other tabs via the native `storage` event.
 * SSR-safe: the server snapshot is always "visible" (false) so markup matches
 * the first client paint and there's no hydration mismatch.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "talise:amounts-hidden";
const EVENT = "talise:amounts-hidden-change";

/** Masked placeholders. Balance keeps the currency symbol/flag visible. */
export const MASK_BALANCE = "••••••";
export const MASK_AMOUNT = "••••";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/** Persist + broadcast the new value to every subscriber in this tab. */
function write(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* storage blocked, the in-memory event still drives this tab */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useHiddenAmounts(): {
  hidden: boolean;
  toggle: () => void;
  setHidden: (v: boolean) => void;
} {
  const hidden = useSyncExternalStore(subscribe, read, () => false);
  return {
    hidden,
    toggle: () => write(!read()),
    setHidden: (v: boolean) => write(v),
  };
}
