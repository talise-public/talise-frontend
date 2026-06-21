"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";

/**
 * Public cheque link (talise.io/c/<id>#<secret>).
 *
 * Talise is mobile-only now — this page no longer claims on the web. It
 * deep-links the recipient straight into the Talise app's claim flow
 * (`talise://c/<id>#<secret>`), and offers a "Get Talise" fallback for
 * anyone who doesn't have the app yet. The secret lives in the URL FRAGMENT
 * (client-only, never hits a server log); `?s=` is accepted as a fallback.
 *
 * `useSearchParams` needs a Suspense boundary in Next 15, so the body lives
 * in `ClaimInner`.
 */
export default function PublicClaimPage() {
  return (
    <Suspense fallback={<main className="landing-mint min-h-dvh bg-bg" />}>
      <ClaimInner />
    </Suspense>
  );
}

function ClaimInner() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id ?? "";
  const [deepLink, setDeepLink] = useState<string>("");

  useEffect(() => {
    const fromHash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    const secret = fromHash ? decodeURIComponent(fromHash) : search.get("s") ?? "";
    if (!id || !secret) return;
    // Custom scheme — opens the app's claim flow directly. The secret stays
    // in the fragment so it never leaves the device.
    const link = `talise://c/${encodeURIComponent(id)}#${secret}`;
    setDeepLink(link);
    // Auto-attempt to open the app on load. If it's installed, iOS hands
    // off immediately; if not, the page stays and the buttons below take over.
    const t = setTimeout(() => {
      window.location.href = link;
    }, 350);
    return () => clearTimeout(t);
  }, [id, search]);

  const openApp = useCallback(() => {
    if (deepLink) window.location.href = deepLink;
  }, [deepLink]);

  return (
    <main className="landing-mint relative min-h-dvh bg-bg text-fg">
      <div className="talise-top-glow" aria-hidden />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6 text-center">
        <span className="font-serif text-[26px] font-medium text-accent" style={{ letterSpacing: "-0.01em" }}>
          Talise
        </span>

        <div className="talise-glass mt-8 w-full rounded-2xl px-7 py-9">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M10.5 18.5h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <h1 className="mt-5 text-[20px] font-medium tracking-[-0.02em] text-fg">
            You&apos;ve been sent money
          </h1>
          <p className="mx-auto mt-3 max-w-[18rem] text-[14px] leading-relaxed text-fg-muted">
            Open this cheque in the Talise app to claim it — the money lands in
            your wallet instantly, gasless.
          </p>

          <button
            type="button"
            onClick={openApp}
            disabled={!deepLink}
            className="mt-7 inline-flex w-full items-center justify-center rounded-full bg-accent-deep px-5 py-3.5 text-[15px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(35,78,20,0.45)] transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            Open in Talise
          </button>
          <a
            href="https://www.talise.io"
            className="mt-3 inline-block text-[13px] text-fg-dim underline-offset-2 hover:underline"
          >
            Don&apos;t have the app? Get Talise
          </a>
        </div>

        <p className="mt-8 font-mono text-[10px] text-fg-dim">
          Talise — pay anyone, anywhere. Built on Sui.
        </p>
      </div>
    </main>
  );
}
