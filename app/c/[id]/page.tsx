"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";

/**
 * Public cheque link (talise.io/c/<id>#<secret>).
 *
 * Talise is mobile-only for the actual claim, this page previews the money
 * link (amount, sender, and the sender's PRIVATE NOTE, decrypted from Walrus
 * using the secret in the URL fragment) and deep-links into the Talise app to
 * finish claiming (`talise://c/<id>#<secret>`). The secret lives in the URL
 * FRAGMENT (client-only, never hits a server log); `?s=` is a fallback.
 */
export default function PublicClaimPage() {
  return (
    <Suspense fallback={<main className="bp-page min-h-dvh" />}>
      <ClaimInner />
    </Suspense>
  );
}

type Preview = {
  amountUsd: number;
  status: string;
  note: string | null;
  creatorDisplay: string;
  claimable: boolean;
};

function ClaimInner() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id ?? "";
  const [secret, setSecret] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fromHash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    const s = fromHash ? decodeURIComponent(fromHash) : search.get("s") ?? "";
    setSecret(s);
    if (!id || !s) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/cheques/${encodeURIComponent(id)}/preview?s=${encodeURIComponent(s)}`);
        if (r.ok) setPreview((await r.json()) as Preview);
      } catch {
        /* show the generic claim card on any error */
      } finally {
        setLoading(false);
      }
    })();
  }, [id, search]);

  const deepLink = id && secret ? `talise://c/${encodeURIComponent(id)}#${secret}` : "";
  const openApp = useCallback(() => {
    if (deepLink) window.location.href = deepLink;
  }, [deepLink]);

  const amount =
    preview != null
      ? preview.amountUsd.toLocaleString("en-US", { style: "currency", currency: "USD" })
      : null;
  const claimed = preview?.status === "claimed";
  const expired = preview?.status === "expired";

  return (
    <main className="bp-page relative min-h-dvh overflow-hidden">
      <div className="bp-frame relative flex min-h-dvh w-full flex-col items-center justify-center px-6 text-center" style={{ maxWidth: 520 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        <span
          className="text-[26px] text-[var(--color-fg)]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500, letterSpacing: "-0.03em" }}
        >
          Talise
        </span>

        <div className="bp-card mt-8 w-full max-w-sm px-7 py-9">
          <span className="mx-auto flex size-14 items-center justify-center rounded-[8px] bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M10.5 18.5h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>

          {loading ? (
            <p className="mt-6 font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">Loading…</p>
          ) : preview ? (
            <>
              <p className="mt-5 font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">
                {preview.creatorDisplay} sent you
              </p>
              <div
                className="mt-1 tabular-nums text-[var(--color-fg)]"
                style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontSize: 40, letterSpacing: "-0.02em", fontWeight: 500 }}
              >
                {amount}
              </div>

              {preview.note ? (
                <div className="mt-5 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-5 py-4 text-left">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
                    A note for you
                  </div>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--color-fg)]">{preview.note}</p>
                </div>
              ) : null}

              {claimed ? (
                <p className="mt-6 font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">This money link has already been claimed.</p>
              ) : expired ? (
                <p className="mt-6 font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">This money link has expired.</p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={openApp}
                    disabled={!deepLink}
                    className="mt-7 inline-flex w-full items-center justify-center rounded-[8px] bg-[var(--color-accent-deep)] px-5 py-3.5 font-mono text-[13px] uppercase tracking-[0.1em] text-white transition-transform active:scale-[0.98] disabled:opacity-50"
                  >
                    Claim in Talise
                  </button>
                  <a
                    href="https://www.talise.io"
                    className="mt-3 inline-block font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-fg-dim)] underline-offset-2 hover:underline"
                  >
                    Don&apos;t have the app? Get Talise
                  </a>
                </>
              )}
            </>
          ) : (
            <>
              <h1 className="mt-5 text-[20px] tracking-[-0.02em] text-[var(--color-fg)]" style={{ fontWeight: 500 }}>
                You&apos;ve been sent money
              </h1>
              <p className="mx-auto mt-3 max-w-[18rem] text-[14px] leading-relaxed text-[var(--color-fg-muted)]">
                Open this money link in the Talise app to claim it, it lands in
                your wallet instantly, gasless.
              </p>
              <button
                type="button"
                onClick={openApp}
                disabled={!deepLink}
                className="mt-7 inline-flex w-full items-center justify-center rounded-[8px] bg-[var(--color-accent-deep)] px-5 py-3.5 font-mono text-[13px] uppercase tracking-[0.1em] text-white transition-transform active:scale-[0.98] disabled:opacity-50"
              >
                Open in Talise
              </button>
              <a
                href="https://www.talise.io"
                className="mt-3 inline-block font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-fg-dim)] underline-offset-2 hover:underline"
              >
                Don&apos;t have the app? Get Talise
              </a>
            </>
          )}
        </div>

        <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
          Talise, pay anyone, anywhere. Built on Sui.
        </p>
      </div>
    </main>
  );
}
