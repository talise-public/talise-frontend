"use client";

import { Diamond } from "@/components/Diamond";
import { triggerOauthSignIn } from "@/lib/zkclient";

/**
 * Access gate for the standalone /perps surface. Not signed in → Continue with
 * Google (returns to /perps). Signed in but not yet allowed into the beta → a
 * calm waiting message. Mirrors the app's gate, in the perps chrome.
 */
export function PerpsGate({ blocked, name }: { blocked: boolean; name: string | null }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 flex-none items-center border-b border-[var(--color-line)] px-4 lg:px-8">
        <div className="flex items-center gap-2.5">
          <Diamond />
          <span className="text-[18px] font-[500] leading-none tracking-[-0.05em]" style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>talise</span>
          <span className="text-[var(--color-fg-dim)]">/</span>
          <span className="font-mono text-[13px] uppercase leading-none tracking-[0.06em] text-[var(--color-fg-muted)]">Perps</span>
          <span className="bg-[var(--color-accent-light)] px-2 py-[3px] font-mono text-[9.5px] uppercase leading-none tracking-[0.08em] text-[#1c3d12]">beta</span>
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[420px] text-center">
          {blocked ? (
            <>
              <h1
                className="text-[34px] leading-[1.05] tracking-[-0.05em]"              >
                You&apos;re on the list.
              </h1>
              <p className="mx-auto mt-3 max-w-[34ch] font-mono text-[13px] leading-[1.7] text-[var(--color-fg-muted)]">
                {name ? `Thanks, ${name.split(" ")[0]}. ` : ""}Your account is ready, Perps access is opening in waves. We&apos;ll email you the moment it&apos;s your turn.
              </p>
              <a
                href="/app"
                className="mt-6 inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.06em] text-[var(--color-fg)]"
              >
                Open your wallet <span aria-hidden>↗</span>
              </a>
            </>
          ) : (
            <>
              <h1
                className="text-[36px] leading-[1.04] tracking-[-0.05em]"              >
                Trade perps
                <br />
                on Talise.
              </h1>
              <p className="mx-auto mt-3 max-w-[32ch] font-mono text-[13px] leading-[1.7] text-[var(--color-fg-muted)]">
                Crypto &amp; stocks, up to 25× leverage. Sign in with Google, no wallet, no seed phrase.
              </p>
              <button
                onClick={() => triggerOauthSignIn({ returnTo: "/perps" })}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-[8px] bg-[var(--color-accent-deep)] px-6 py-3 font-mono text-[13px] uppercase tracking-[0.06em] text-white transition-transform active:scale-95"
              >
                Continue with Google
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
