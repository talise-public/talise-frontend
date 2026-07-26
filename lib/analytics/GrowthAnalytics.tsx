"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { bootGrowth, flush, track } from "@/lib/analytics/growth-browser";

/**
 * The web client's single mount point for the growth pipeline. Rendered once
 * from `app/layout.tsx`, next to `<Analytics />` (Vercel Web Analytics stays —
 * it answers "which pages get traffic"; this answers "who came back, from
 * where, and did they transact", which Vercel cannot).
 *
 * Renders nothing. Two jobs:
 *
 *   1. `bootGrowth()` on mount → app_first_open / first_touch / invite_clicked
 *      / app_open. This is what makes web DAU and retention exist at all.
 *
 *   2. ROUTE-DERIVED FUNNEL. Because it sits in the root layout it sees every
 *      navigation, so the coarse funnel is derived from the pathname rather
 *      than from a call site in each page. That is a deliberate trade: it gives
 *      web funnel coverage today without touching a single product component,
 *      and any page can later import `track()` for a precise event without
 *      changing anything here.
 *
 * The pathname is mapped through a WHITELIST (`SURFACES`), so a dynamic route
 * segment — a handle in `/u/[handle]`, an invoice id in `/i/[id]` — can never
 * become an analytics dimension. Unknown paths are reported as "other".
 */

/** Path prefix → coarse surface name. Longest match wins. */
const SURFACES: ReadonlyArray<readonly [string, string]> = [
  ["/app/ramps", "ramps"],
  ["/app/rewards", "rewards"],
  ["/app/activity", "activity"],
  ["/app/earn", "earn"],
  ["/app/requests", "requests"],
  ["/app/settings", "settings"],
  ["/app/verify", "verify"],
  ["/app/agent", "copilot"],
  ["/app/private", "private"],
  ["/app/work", "work"],
  ["/app/rules", "rules"],
  ["/app/pay", "pay"],
  ["/app", "home"],
  ["/auth/finish", "auth.finish"],
  ["/waitlist", "waitlist"],
  ["/business", "business"],
  ["/support", "support"],
  ["/analytics", "analytics"],
  ["/blog", "blog"],
  ["/pay", "pay.public"],
  ["/u", "profile.public"],
  ["/req", "request.public"],
  ["/c", "cheque.public"],
  ["/i", "invoice.public"],
  ["/", "landing"],
];

function surfaceFor(pathname: string): string {
  for (const [prefix, name] of SURFACES) {
    if (prefix === "/" ? pathname === "/" : pathname.startsWith(prefix)) return name;
  }
  return "other";
}

export function GrowthAnalytics() {
  const pathname = usePathname();
  const booted = useRef(false);
  const lastSurface = useRef<string | null>(null);

  // Boot once per page load.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    bootGrowth();
  }, []);

  // Route-derived funnel. Fires only when the coarse SURFACE changes, so
  // shallow param churn inside one screen doesn't spam the table.
  useEffect(() => {
    if (!pathname) return;
    const surface = surfaceFor(pathname);
    if (lastSurface.current === surface) return;
    lastSurface.current = surface;

    track("screen_view", { surface });

    // `/auth/finish` is only ever reached by a completed OAuth round-trip, so
    // it is an exact signal for "the sign-in itself succeeded" — which
    // separates "abandoned in Google's sheet" from "our exchange failed".
    // `signup_completed` itself is NOT emitted here: the server derives it from
    // `users.created_at`, so a client can't fabricate a signup.
    if (surface === "auth.finish") {
      track("signup_auth_completed", { surface, status: "ok", immediate: true });
    }
    if (surface === "waitlist") {
      track("signup_started", { surface, step: "waitlist" });
    }
  }, [pathname]);

  // Best-effort final flush when the component unmounts (SPA teardown).
  useEffect(() => () => flush(true), []);

  return null;
}

export default GrowthAnalytics;
