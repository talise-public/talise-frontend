import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { userByHandle, getWaitlistRank, ensureReferralCode } from "@/lib/db";
import { TaliseProfileCard } from "@/components/TaliseProfileCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public Talise profile / invite page: `/u/<handle>`.
 *
 * This is the link waitlist members share. It shows their Talise profile card
 * + a "claim your name" CTA that routes the visitor into the waitlist with the
 * owner's referral code (?ref=CODE) so signing up credits them and bumps them
 * up the line. The social-preview image is rendered by the sibling
 * opengraph-image.tsx.
 */

function cleanHandle(raw: string): string {
  return decodeURIComponent(raw).replace(/^@+/, "").trim().toLowerCase();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const h = cleanHandle(handle);
  const title = `@${h} on Talise`;
  const description = `${h} is on the Talise waitlist, the gasless dollar wallet on Sui. Claim your own name and skip the line.`;
  return {
    title,
    description,
    openGraph: { title, description, url: `/u/${h}`, type: "profile" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const h = cleanHandle(handle);
  const user = await userByHandle(h);
  if (!user || !user.talise_username) notFound();

  const code = await ensureReferralCode(user.id, user.name ?? user.email);
  const { position } = await getWaitlistRank(user.id);
  const referralCount = Number(user.referral_count ?? 0) || 0;
  const joinHref = `/waitlist?ref=${encodeURIComponent(code)}`;

  return (
    <main className="bp-page relative min-h-screen overflow-hidden text-[var(--color-fg)]">
      <div
        className="bp-frame relative mx-auto flex min-h-screen flex-col items-center gap-6 px-5 py-10"
        style={{ maxWidth: 420 }}
      >
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        {/* brand */}
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--color-accent)] transition hover:text-[var(--color-fg)]"
        >
          Talise
        </Link>

        <div className="text-center">
          <h1
            className="text-[22px] font-medium tracking-[-0.03em] text-[var(--color-fg)]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
          >
            <span className="text-[var(--color-accent-deep)]">@{user.talise_username}</span>{" "}
            is on Talise
          </h1>
          <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-[1.6] text-[var(--color-fg-muted)]">
            The gasless dollar wallet on Sui. Send digital dollars like a text -
            no gas, no seed phrases. Claim your name before launch.
          </p>
        </div>

        {/* the profile card */}
        <div className="w-full">
          <TaliseProfileCard
            handle={user.talise_username}
            position={position}
            referralCount={referralCount}
          />
        </div>

        {/* CTA, carries the owner's referral code into the waitlist */}
        <Link
          href={joinHref}
          className="inline-flex w-full items-center justify-center rounded-[8px] bg-[var(--color-accent-deep)] px-6 py-3.5 font-mono text-[12px] font-medium uppercase tracking-[0.12em] text-white transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent-deep)_88%,white)]"
        >
          Claim your Talise name
        </Link>
        <p className="text-center font-mono text-[11px] tracking-[0.02em] text-[var(--color-fg-dim)]">
          Free. Sign in with Google, your name mints to your wallet instantly.
        </p>
      </div>
    </main>
  );
}
