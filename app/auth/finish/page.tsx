"use client";

/**
 * /auth/finish, the staged sign-in loader.
 *
 * Google's OAuth redirect lands on /auth/callback, which (for web) bounces
 * here instantly with ?code&state. We POST those to /api/auth/exchange and
 * play a 4-step progress sequence WHILE the real work runs (token exchange →
 * Shinami wallet → account setup → cookies), ending on "You're all set" and a
 * redirect into the app. Steps advance on a gentle timer but the final step
 * only fires when the server actually finishes, honest theater.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Diamond } from "@/components/Diamond";

const STEPS = [
  "Verifying with Google",
  "Securing your Sui wallet",
  "Personalizing your account",
] as const;

const STEP_MS = 1100; // gentle cadence between step advances
const DONE_DWELL_MS = 900; // how long "You're all set" stays before redirect

function FinishInner() {
  const params = useSearchParams();
  const started = useRef(false);
  const [step, setStep] = useState(0); // 0..2 = STEPS index; 3 = all set
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    if (!code || !state) {
      window.location.replace("/?err=missing_code");
      return;
    }

    // Advance through the intermediate steps on a timer, but never past the
    // last one until the exchange actually resolves.
    const timer = setInterval(() => {
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }, STEP_MS);

    void (async () => {
      try {
        const r = await fetch("/api/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, state }),
        });
        const j = (await r.json()) as { ok?: boolean; dest?: string; err?: string };
        clearInterval(timer);
        if (!r.ok || !j.ok || !j.dest) {
          setFailed(true);
          window.location.replace(`/?err=${encodeURIComponent(j.err ?? "signin_failed")}`);
          return;
        }
        // Land on "You're all set", let it breathe, then enter the app.
        setStep(STEPS.length);
        // Warm the destination while the check-mark shows.
        try {
          const head = document.createElement("link");
          head.rel = "prefetch";
          head.href = j.dest;
          document.head.appendChild(head);
        } catch {
          /* best-effort */
        }
        setTimeout(() => window.location.replace(j.dest as string), DONE_DWELL_MS);
      } catch {
        clearInterval(timer);
        setFailed(true);
        window.location.replace("/?err=signin_failed");
      }
    })();

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allSet = step >= STEPS.length;

  return (
    <main className="bp-page flex min-h-dvh flex-col items-center justify-center px-6">
      {/* Wordmark, the real brand mark, light weight */}
      <div className="mb-10 flex items-center gap-2.5">
        <Diamond />
        <span
          className="text-[20px] lowercase tracking-[-0.03em] text-[var(--color-fg)]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500 }}
        >
          talise
        </span>
      </div>

      {/* Stage */}
      <div className="flex w-full max-w-xs flex-col items-center">
        {allSet ? (
          <>
            <span className="flex size-14 items-center justify-center rounded-[10px] bg-[var(--color-accent-deep)] text-white">
              {/* check */}
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M5 12.5l4.2 4.2L19 7"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <p
              className="mt-5 text-[17px] tracking-[-0.03em] text-[var(--color-fg)]"
              style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500 }}
            >
              You&rsquo;re all set
            </p>
          </>
        ) : (
          <>
            {/* Spinner, soft ring with an accent comet arc */}
            <span className="relative flex size-14 items-center justify-center" aria-hidden>
              <span className="absolute inset-0 rounded-full border-[3px] border-[var(--color-accent-soft)]" />
              <span className="absolute inset-0 animate-spin rounded-full border-[3px] border-transparent border-t-[var(--color-accent-deep)]" />
            </span>
            <p
              key={step}
              className="mt-5 animate-[fadeIn_300ms_ease] font-mono text-[13px] text-[var(--color-fg-muted)]"
              aria-live="polite"
            >
              {failed ? "Something went wrong…" : STEPS[Math.min(step, STEPS.length - 1)]}
            </p>
          </>
        )}

        {/* Step ticks */}
        <div className="mt-6 flex items-center gap-2" aria-hidden>
          {[...STEPS, "done"].map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-[3px] transition-all duration-300 ${
                i < step || allSet
                  ? "w-6 bg-[var(--color-accent-deep)]"
                  : i === step
                    ? "w-6 bg-[var(--color-accent-deep)]/40"
                    : "w-1.5 bg-[var(--color-accent-soft)]"
              }`}
            />
          ))}
        </div>
      </div>

      <style jsx global>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(3px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </main>
  );
}

export default function AuthFinishPage() {
  return (
    <Suspense
      fallback={
        <main className="bp-page flex min-h-dvh items-center justify-center" />
      }
    >
      <FinishInner />
    </Suspense>
  );
}
