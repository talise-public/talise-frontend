"use client";

import { useEffect } from "react";

// Mirrors REFERRAL_CODE_RE in lib/db.ts (alphabet excludes ambiguous
// O/I/L/0/1). Validate client-side so we never POST junk to the capture route.
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Captures a referral code from `?ref=CODE` on ANY page into the signed,
 * httpOnly `talise_ref` cookie (via POST /api/referral/capture). Mounted once
 * in the root layout so an invite link works no matter where it lands. The
 * cookie is read + attributed to the inviter on the new user's first Google
 * sign-in (see app/auth/callback/route.ts). Renders nothing.
 */
export function ReferralCapture() {
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (!ref) return;
      const code = ref.trim().toUpperCase();
      if (!CODE_RE.test(code)) return;
      // Fire-and-forget; the cookie is set server-side. `keepalive` so it
      // still completes if the user immediately navigates (e.g. clicks "Join").
      void fetch("/api/referral/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* no-op — capture is best-effort */
    }
  }, []);

  return null;
}
