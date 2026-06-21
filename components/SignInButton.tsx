"use client";

import { useState } from "react";
import { triggerOauthSignIn } from "@/lib/zkclient";
import { SigninPreloader } from "./SigninPreloader";

type Variant = "primary" | "ghost" | "full";

export function SignInButton({
  returnTo,
  variant = "primary",
  label = "Continue with Google",
  className,
}: {
  returnTo?: string;
  variant?: Variant;
  label?: string;
  className?: string;
}) {
  const [stage, setStage] = useState<"idle" | "preparing" | "redirecting" | "error">(
    "idle"
  );
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    setStage("preparing");
    try {
      setStage("redirecting");
      await triggerOauthSignIn({ returnTo });
    } catch (e) {
      setErr((e as Error).message);
      setStage("error");
    }
  }

  const base =
    "group inline-flex items-center justify-center gap-3 rounded-2xl text-[14px] font-medium transition disabled:cursor-wait disabled:opacity-80";

  const styles: Record<Variant, string> = {
    primary:
      "h-[54px] bg-[var(--color-fg)] px-5 text-[var(--color-bg)] hover:bg-[var(--color-accent-soft)] w-full",
    ghost:
      "border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-1.5 text-[13px] text-[var(--color-fg)] hover:border-[var(--color-accent)]",
    full: "bg-[var(--color-fg)] px-5 py-3 text-[14px] text-[var(--color-bg)] hover:bg-[var(--color-accent-soft)]",
  };

  const display = (() => {
    if (stage === "preparing") return variant === "ghost" ? "…" : "Preparing your wallet…";
    if (stage === "redirecting") return variant === "ghost" ? "…" : "Redirecting…";
    return label;
  })();

  const overlayActive = stage === "preparing" || stage === "redirecting";

  return (
    <>
      <SigninPreloader
        active={overlayActive}
        stage={stage === "redirecting" ? "redirecting" : "preparing"}
      />
      <button
        type="button"
        onClick={go}
        disabled={overlayActive}
        className={`${base} ${styles[variant]} ${className ?? ""}`}
      >
        {variant !== "ghost" && stage === "idle" && <GoogleMark />}
        {display}
      </button>
      {err && (
        <p className="mt-2 text-[12px] text-[var(--color-fg)]">! {err}</p>
      )}
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.83z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}
