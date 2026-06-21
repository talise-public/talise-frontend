"use client";

import { useEffect, useRef, useState } from "react";
import { triggerOauthSignIn } from "@/lib/zkclient";
import { WaitlistDashboard } from "./WaitlistDashboard";

/**
 * Waitlist form. Google-first flow:
 *
 *   1. Mount: probe /api/auth/me. If there's a session, jump to the
 *      claim step (or show "welcome back" if the user already owns a
 *      handle). Otherwise render the Google sign-in CTA.
 *   2. User clicks "Sign in with Google" → triggerOauthSignIn bounces
 *      to Google, /auth/callback drops them back at /waitlist with a
 *      live session cookie, the form auto-advances to claim.
 *   3. User picks a handle → POST /api/waitlist/handle/claim with just
 *      `{ handle }`. The route derives the email from the session and
 *      UPSERTs the waitlist row. The handle mints on chain inside the
 *      same request; a confirmation email is sent on success.
 *
 * There is no email input on this page anymore. The legacy
 * /api/waitlist endpoint is still alive for external links but the new
 * UI never calls it.
 */

type HandleAvailability =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; handle: string }
  | { kind: "taken" }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

type ClaimStatus = "idle" | "claiming" | "claimed" | "error";

type ClaimSuccess = {
  handle: string;
  mintDigest?: string;
  suiAddress?: string;
};

// Outer state machine. `checking` is the initial probe while we race
// /api/auth/me and /api/waitlist/handle/existing. After that we land
// on exactly one of:
//   • needsSignIn   — render the Google CTA
//   • signedOutCancel — user backed out of the Google sheet (quiet pill)
//   • needsClaim    — session active, no handle yet → handle picker
//   • existing      — session active + already owns a handle (welcome back)
type Phase =
  | "checking"
  | "needsSignIn"
  | "signedOutCancel"
  | "needsClaim"
  | "existing";

type Session = { email: string; suiAddress?: string };

export function WaitlistForm() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [session, setSession] = useState<Session | null>(null);
  const [existingHandle, setExistingHandle] = useState<string | null>(null);
  const [signInPending, setSignInPending] = useState(false);
  const [signInError, setSignInError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me", {
          cache: "no-store",
        }).catch(() => null);
        if (cancelled) return;

        const meBody = meRes
          ? ((await meRes.json().catch(() => ({}))) as {
              signedIn?: boolean;
              email?: string;
              suiAddress?: string;
              handle?: string | null;
            })
          : {};

        if (!meBody.signedIn || !meBody.email) {
          setPhase("needsSignIn");
          return;
        }

        const sess: Session = {
          email: meBody.email,
          suiAddress: meBody.suiAddress,
        };
        setSession(sess);

        // /api/auth/me is the source of truth — `user.talise_username`
        // resolves to `handle` on the response. If it's set the user
        // has already claimed; otherwise drop straight into the
        // picker. The old /handle/existing backstop call doubled the
        // spinner time on every signed-in load for new users without
        // adding signal — /api/auth/me already covers it.
        if (meBody.handle) {
          setExistingHandle(meBody.handle);
          setPhase("existing");
          return;
        }

        setPhase("needsClaim");
      } catch {
        if (!cancelled) setPhase("needsSignIn");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSignIn() {
    if (signInPending) return;
    setSignInPending(true);
    setSignInError("");
    try {
      // Stash the return-to so /auth/callback drops the user back
      // here with a session cookie. On reload, the useEffect above
      // re-probes and advances to needsClaim (or existing).
      await triggerOauthSignIn({ returnTo: "/waitlist" });
    } catch (err) {
      setSignInPending(false);
      // User cancelled the Google sheet. Surface a quiet pill, not
      // a loud error.
      const msg = (err as Error).message ?? "";
      if (
        /cancel/i.test(msg) ||
        /closed/i.test(msg) ||
        /aborted/i.test(msg)
      ) {
        setPhase("signedOutCancel");
        return;
      }
      setSignInError(msg || "Sign-in failed. Try again.");
    }
  }

  if (phase === "checking") {
    return (
      <div
        className="mx-auto flex w-full max-w-[440px] items-center justify-center gap-2.5 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-6 text-center sm:px-6"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent-deep)]"
        />
        <span className="text-[12px] text-[var(--color-fg-muted)]">Checking your account…</span>
      </div>
    );
  }

  if (phase === "existing" && existingHandle && session) {
    return <WaitlistDashboard handle={existingHandle} email={session.email} />;
  }

  if (phase === "needsClaim" && session) {
    return <HandleClaim session={session} />;
  }

  // needsSignIn (or signedOutCancel, which renders the same CTA with a
  // muted "cancelled" pill above it).
  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col gap-3">
      <div className="px-1 text-center">
        <div className="text-[15px] font-medium text-[var(--color-fg)]">
          Sign in to claim your handle.
        </div>
        <div className="mt-1 text-[12px] leading-[1.55] text-[var(--color-fg-muted)]">
          Talise creates a Sui wallet from your Google account. Your
          handle mints to that wallet the moment you click Claim.
        </div>
      </div>

      {phase === "signedOutCancel" && (
        <div
          className="px-4 text-center text-[12px] text-[var(--color-fg-muted)]"
          role="status"
          aria-live="polite"
        >
          Sign-in cancelled. Try again when you are ready.
        </div>
      )}

      <button
        type="button"
        onClick={onSignIn}
        disabled={signInPending}
        className="inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-3 text-[14px] font-medium text-[var(--color-fg)] shadow-[0_2px_10px_rgba(35,78,20,0.12)] transition hover:border-[var(--color-accent-deep)] hover:shadow-[0_4px_16px_rgba(35,78,20,0.16)] disabled:opacity-50"
      >
        {signInPending ? (
          <>
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent-deep)]"
            />
            Opening Google…
          </>
        ) : (
          "Sign in with Google"
        )}
      </button>

      {signInError && (
        <div className="px-4 text-center text-[12px] text-[#b42318]" role="alert">
          {signInError}
        </div>
      )}
    </div>
  );
}

/**
 * Handle claim sub-flow. Shown after Google sign-in completes (so we
 * always have an authenticated `session` to work with). Debounced
 * availability check on each keystroke (350ms) → optimistic CTA
 * enabled only when the server returns `available: true`. On claim
 * success the form collapses to a confirmation banner.
 *
 * The claim POST sends ONLY the handle — the route derives the email
 * from the session cookie.
 */
function HandleClaim({ session }: { session: Session }) {
  const { email } = session;
  const [handle, setHandle] = useState("");
  const [avail, setAvail] = useState<HandleAvailability>({ kind: "idle" });
  const [claim, setClaim] = useState<ClaimStatus>("idle");
  const [claimSuccess, setClaimSuccess] = useState<ClaimSuccess | null>(null);
  const [claimError, setClaimError] = useState("");
  // Set when the claim POST comes back 409 alreadyClaimed (the user
  // already owns a handle, e.g. they claimed in another tab). We swap to
  // the "you're in" card using the handle from the 409 body rather than
  // showing a generic error.
  const [alreadyClaimed, setAlreadyClaimed] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (claim === "claimed") return;
    const trimmed = handle.trim();
    if (!trimmed) {
      setAvail({ kind: "idle" });
      return;
    }

    // Debounce so we don't hit the API on every keystroke. 350ms is the
    // sweet spot between feeling instant and saving round trips.
    const mySeq = ++seqRef.current;
    setAvail({ kind: "checking" });
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/waitlist/handle/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, handle: trimmed }),
        });
        if (mySeq !== seqRef.current) return; // stale
        const body = (await r.json().catch(() => ({}))) as {
          available?: boolean;
          normalized?: string;
          error?: string;
          reason?: string;
        };
        if (r.status === 400) {
          setAvail({
            kind: "invalid",
            message: body.error || "Invalid handle.",
          });
          return;
        }
        if (!r.ok) {
          setAvail({
            kind: "error",
            message: body.error || "Could not check that handle.",
          });
          return;
        }
        if (body.available && body.normalized) {
          setAvail({ kind: "available", handle: body.normalized });
        } else {
          setAvail({ kind: "taken" });
        }
      } catch (err) {
        if (mySeq !== seqRef.current) return;
        setAvail({ kind: "error", message: (err as Error).message });
      }
    }, 350);

    return () => clearTimeout(t);
  }, [handle, email, claim]);

  async function onClaim() {
    if (avail.kind !== "available") return;
    setClaim("claiming");
    setClaimError("");
    try {
      // No email in the body — the route reads it from the session
      // cookie. Sending it would be a footgun if it ever drifted out
      // of sync with the actual signed-in user.
      const r = await fetch("/api/waitlist/handle/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: avail.handle }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        handle?: string;
        mintDigest?: string;
        suiAddress?: string;
        error?: string;
        alreadyClaimed?: boolean;
        reserved?: boolean;
        message?: string;
      };
      if (r.status === 503 && body.reserved && body.handle) {
        // Operator gas was low: the name IS reserved (held in the DB, mint
        // queued for finalisation). Show the same "you're in" dashboard — the
        // user owns the name — rather than a false "couldn't claim" error.
        setClaimSuccess({ handle: body.handle });
        setClaim("claimed");
        return;
      }
      if (r.status === 401) {
        // Session expired between mount and claim. Reload the page so
        // the outer form re-probes /api/auth/me and shows the sign-in
        // CTA again.
        window.location.reload();
        return;
      }
      if (r.status === 409 && body.alreadyClaimed && body.handle) {
        // Race: the user already owns a handle (claimed in another tab
        // since this page loaded). Swap to the same "you're in" card
        // with their existing handle instead of a jarring error.
        setAlreadyClaimed(body.handle);
        setClaim("idle");
        setClaimError("");
        return;
      }
      if (!r.ok || !body.ok || !body.handle) {
        throw new Error(body.error || body.message || "Couldn't claim that handle.");
      }
      setClaimSuccess({
        handle: body.handle,
        mintDigest: body.mintDigest,
        suiAddress: body.suiAddress,
      });
      setClaim("claimed");
      // Stay put — the dashboard (position + invite link + shareable profile
      // card) IS the destination now. No more bounce to the marketing root;
      // a fresh claimer's first job is to grab their link and start referring.
    } catch (err) {
      setClaim("error");
      setClaimError((err as Error).message);
    }
  }

  // 409 mid-flow: they already own a handle. Drop them on the dashboard.
  if (alreadyClaimed) {
    return <WaitlistDashboard handle={alreadyClaimed} email={email} />;
  }

  if (claim === "claimed" && claimSuccess) {
    return <WaitlistDashboard handle={claimSuccess.handle} email={email} />;
  }

  const ctaEnabled = avail.kind === "available" && claim !== "claiming";

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col gap-3">
      <style>{`
        .waitlist-form input:-webkit-autofill,
        .waitlist-form input:-webkit-autofill:hover,
        .waitlist-form input:-webkit-autofill:focus,
        .waitlist-form input:-webkit-autofill:active {
          -webkit-text-fill-color: #15300c;
          -webkit-box-shadow: 0 0 0 1000px transparent inset;
          transition: background-color 9999s ease-in-out 0s;
          caret-color: #15300c;
          background-clip: content-box !important;
        }
      `}</style>

      <div className="px-1 text-center">
        <div className="text-[15px] font-medium text-[var(--color-fg)]">
          Now claim your @handle.
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
          Mints on chain to your wallet the moment you click Claim.
        </div>
      </div>

      <div className="waitlist-form flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] p-1.5 transition-colors focus-within:border-[var(--color-accent-deep)]">
        <div className="flex min-w-0 flex-1 items-center pl-3 pr-1 sm:pl-4">
          <span className="select-none text-[15px] text-[var(--color-fg-muted)]">@</span>
          <input
            id="waitlist-handle"
            name="handle"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="yourname"
            value={handle}
            onChange={(e) => {
              const next = e.target.value.replace(/^@+/, "");
              setHandle(next);
              if (claim === "error") setClaim("idle");
            }}
            className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[15px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-dim)] focus:outline-none"
            disabled={claim === "claiming"}
            aria-describedby="handle-hint"
            maxLength={32}
          />
        </div>
        <button
          type="button"
          onClick={onClaim}
          disabled={!ctaEnabled}
          className="inline-flex flex-none items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[var(--color-accent-deep)] px-4 py-2.5 text-[14px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(35,78,20,0.45)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent-deep)_88%,white)] disabled:opacity-50 sm:px-5"
        >
          {claim === "claiming" ? (
            <>
              <span
                aria-hidden
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
              <span className="hidden sm:inline">Claiming…</span>
            </>
          ) : (
            "Claim"
          )}
        </button>
      </div>

      <div id="handle-hint" className="px-4 text-[12px]" aria-live="polite">
        {avail.kind === "idle" && (
          <span className="text-[var(--color-fg-dim)]">
            Letters, numbers, hyphens. 3-32 chars.
          </span>
        )}
        {avail.kind === "checking" && (
          <span className="text-[var(--color-fg-muted)]">Checking…</span>
        )}
        {avail.kind === "available" && (
          <span className="text-[var(--color-accent-deep)]">
            {avail.handle}@talise.sui is available.
          </span>
        )}
        {avail.kind === "taken" && (
          <span className="text-[#b42318]">Taken. Try another.</span>
        )}
        {avail.kind === "invalid" && (
          <span className="text-[var(--color-fg-muted)]">{avail.message}</span>
        )}
        {avail.kind === "error" && (
          <span className="text-[#b42318]">{avail.message}</span>
        )}
      </div>

      {claim === "error" && claimError && (
        <div className="px-4 text-[12px] text-[#b42318]" role="alert">
          {claimError}
        </div>
      )}
    </div>
  );
}
