"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Tick01Icon,
  NewTwitterIcon,
  ArrowUp01Icon,
} from "@hugeicons/core-free-icons";
import { TaliseProfileCard } from "@/components/TaliseProfileCard";

/**
 * Post-claim waitlist dashboard (DeepBook-style). Shown to a signed-in member
 * who owns a handle, both on a fresh claim and on return. Leads with the live
 * waitlist position, then the shareable Talise profile card, then the invite
 * link (Copy + Share on X) and the referral tally. Each verified friend who
 * joins through the link moves the user up the list.
 *
 * `handle` + `email` are known by the parent (from /api/auth/me / the claim
 * response) so the shell renders instantly; the referral code, count, and
 * position stream in from /api/waitlist/status.
 */
type Status = {
  referralCode: string;
  referralCount: number;
  position: number | null;
  total: number | null;
};

export function WaitlistDashboard({
  handle,
  email,
}: {
  handle: string;
  email?: string;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/waitlist/status", { cache: "no-store" });
        if (cancelled || !r.ok) return;
        const b = (await r.json()) as {
          referralCode?: string;
          referralCount?: number;
          position?: number;
          total?: number;
        };
        if (cancelled) return;
        setStatus({
          referralCode: b.referralCode ?? "",
          referralCount: b.referralCount ?? 0,
          position: typeof b.position === "number" ? b.position : null,
          total: typeof b.total === "number" ? b.total : null,
        });
      } catch {
        /* leave shell rendered; numbers just stay as "…" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://talise.io";
  // Invite link → the public /waitlist?ref=CODE surface. ReferralCapture in the
  // root layout reads ?ref and credits this user when their friend signs up.
  // (The richer /u/<handle> profile page + OG card is local-only for now, so
  // we don't route public invites through it, that link would 404.)
  const referralCode = status?.referralCode ?? "";
  const inviteLink = referralCode
    ? `${origin}/waitlist?ref=${referralCode}`
    : `${origin}/waitlist`;
  const position = status?.position ?? null;
  const referralCount = status?.referralCount ?? 0;

  // Handle reads as plain text (`eromonsele@talise`), NOT a blue @mention of a
  // nonexistent account; only @taliseio (the real X handle) is mentioned. The
  // invite link lives INSIDE the text on its own line, so we omit the `url`
  // param, otherwise X would append a duplicate link below the tweet.
  const shareText = `I just claimed ${handle}@talise on @taliseio, the gasless dollar wallet on Sui.

Join the waitlist and claim your name:

${inviteLink}`;
  const xIntent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked, no-op */
    }
  }

  return (
    <div className="mx-auto w-full max-w-[480px] lg:max-w-[1040px]">
      {/* Position headline, spans the full width on top so the two columns
          below start level and stay balanced (no tall-left / short-right gap). */}
      <div className="text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-fg-dim)]">
          You&apos;re on the waitlist
        </div>
        {email ? (
          <div className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            Confirmed for{" "}
            <span className="break-all text-[var(--color-fg)]">{email}</span>
          </div>
        ) : null}
        <div className="mt-3 text-[56px] font-semibold leading-none tracking-tight text-[var(--color-accent-deep)] sm:text-[64px]">
          {position ? `#${position.toLocaleString()}` : "#…"}
        </div>
      </div>

      {/* Two balanced columns: the card stretches to match the actions stack. */}
      <div className="mt-7 grid items-stretch gap-4 sm:gap-5 lg:grid-cols-2">
        {/* LEFT, the shareable profile card (fills the column height) */}
        <TaliseProfileCard
          handle={handle}
          position={position}
          referralCount={referralCount}
          fill
        />

        {/* RIGHT, actions: invite link + referral tally. min-w-0 lets this
            grid column shrink below its content so the long invite URL
            truncates instead of forcing the whole grid (and page) wider. */}
        <div className="flex min-w-0 flex-col gap-4">
      {/* Invite link, Copy + Share on X */}
      <div className="min-w-0 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 sm:p-5">
        <div className="text-[14px] font-medium text-[var(--color-fg)]">
          Your invite link
        </div>
        <p className="mt-1 text-[12px] leading-[1.55] text-[var(--color-fg-muted)]">
          Each friend who joins through your link moves you up the list. The
          higher you climb, the sooner you&apos;re in.
        </p>

        <div className="mt-3 flex min-w-0 items-center gap-2 rounded-full border border-[var(--color-line)] bg-[color-mix(in_srgb,var(--color-surface)_70%,var(--color-bg))] p-1.5 pl-3.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-fg)]">
            {inviteLink.replace(/^https?:\/\//, "")}
          </span>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex flex-none items-center gap-1.5 rounded-full bg-[var(--color-accent-deep)] px-3.5 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent-deep)_88%,white)]"
          >
            <HugeiconsIcon
              icon={copied ? Tick01Icon : Copy01Icon}
              size={14}
              color="currentColor"
              strokeWidth={2.2}
            />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <a
          href={xIntent}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 text-[13px] font-medium text-[var(--color-fg)] transition hover:border-[var(--color-accent-deep)]"
        >
          <HugeiconsIcon
            icon={NewTwitterIcon}
            size={15}
            color="currentColor"
            strokeWidth={1.8}
          />
          Share on X
        </a>
      </div>

      {/* Referral tally + how it works */}
      <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div className="text-[14px] font-medium text-[var(--color-fg)]">
            Referrals
          </div>
          <span className="rounded-full bg-[color-mix(in_srgb,var(--color-accent-deep)_12%,#ffffff)] px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--color-accent-deep)]">
            Verified
          </span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-10 w-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-accent-deep)_12%,#ffffff)] text-[var(--color-accent-deep)]"
          >
            <HugeiconsIcon
              icon={ArrowUp01Icon}
              size={18}
              color="currentColor"
              strokeWidth={2.2}
            />
          </span>
          <div className="text-[20px] font-semibold leading-none tracking-tight text-[var(--color-fg)]">
            {referralCount.toLocaleString()}{" "}
            <span className="text-[13px] font-normal text-[var(--color-fg-muted)]">
              {referralCount === 1 ? "referral" : "referrals"}
            </span>
          </div>
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}
