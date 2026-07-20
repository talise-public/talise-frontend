"use client";

import {
  clearStored,
  clearExpiryMarker,
  signingSessionExpired,
  triggerOauthSignIn,
} from "./zkclient";

/**
 * Expired-session teardown (client).
 *
 * A Talise web session has two halves with different lifetimes:
 *   • the server cookie session (days, sliding), what the layout checks
 *   • the zkLogin ephemeral signing key (sessionStorage, ~55 min), what
 *     actually signs transactions
 *
 * When the signing half lapses the app used to sit in a half-signed-in limbo:
 * pages render (cookie still valid) but any money action bounces through a
 * surprise Google redirect or dies on a server 401. Per product: once the old
 * session is expired the user is SIGNED OUT and signs into a fresh session.
 *
 * `forceFreshSignIn` is the one teardown path: wipe the tab's key + the
 * cross-tab marker, kill the server cookies, then either send the user
 * straight back through Google (reactive: they were mid-action and want to
 * finish) or reload to the sign-in screen (proactive: idle expiry).
 */
export async function forceFreshSignIn(opts?: {
  /** Jump straight into the Google flow (mid-action) instead of landing on
   *  the sign-in screen (idle expiry). */
  reauthNow?: boolean;
  returnTo?: string;
}): Promise<void> {
  clearStored();
  clearExpiryMarker();
  try {
    // POST avoids the GET handler's redirect-to-marketing-home; we control
    // where the user lands next.
    await fetch("/auth/logout", { method: "POST", redirect: "manual" });
  } catch {
    /* network hiccup, cookies survive but the key is gone; sign-in still fixes it */
  }
  const returnTo =
    opts?.returnTo ??
    (typeof location !== "undefined" ? location.pathname : "/app");
  if (opts?.reauthNow) {
    await triggerOauthSignIn({ returnTo });
    return;
  }
  if (typeof location !== "undefined") {
    // Full reload → the server layout sees no session → sign-in screen.
    location.reload();
  }
}

/** True for API failures that mean "this session can't sign anymore". */
export function isSessionExpiryError(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  if (!err) return false;
  if (err.code === "session_rebind_required") return true;
  if (err.code === "NOT_SIGNED_IN") return false; // pre-flight local bounce, already handled
  return err.status === 401;
}

export { signingSessionExpired };
