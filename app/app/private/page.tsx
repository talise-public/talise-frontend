import { HugeiconsIcon } from "@hugeicons/react";
import {
  SquareLock02Icon,
  ShieldKeyIcon,
  Coins01Icon,
} from "@hugeicons/core-free-icons";
import { Eyebrow, StatusPill } from "@/components/app";
import { shieldConfigured, SHIELD } from "@/lib/shield/onchain";

export const dynamic = "force-dynamic";

const DISPLAY = { fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' } as const;

/**
 * /app/private, shielded USDsui send (Talise's own ZK privacy layer).
 *
 * Reached from the iOS "Send private tx" tile (which opens this on the web app,
 * so the Groth16 proof is built in the user's own session; the relayer only
 * sponsors gas, never the note secrets). The shielded pool is published on
 * mainnet as a $2.50/tx operator-trusted pilot, but the SUBSYSTEM is gated by
 * `shieldConfigured()` (SHIELD_PKG + SHIELD_POOL_USDSUI), which stays UNSET in
 * prod until the relayer keypair is funded + the env is set. So this page tells
 * the truth: explainer + honest pilot disclosure, and either "switching on"
 * (current) or the live send form (once flipped on).
 */
export default function PrivatePage() {
  const live = shieldConfigured();
  const capUsd = "$2.50";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-7 pb-10 pt-1">
      <header className="space-y-3">
        <Eyebrow>Private</Eyebrow>
        <h1
          className="max-w-xl text-[clamp(28px,6vw,44px)] font-[500] leading-[1.0] tracking-[-0.05em] text-[#15300c]"
          style={DISPLAY}
        >
          Send USDsui, shielded.
        </h1>
        <p className="max-w-md text-[15px] leading-relaxed text-[#3a5230]">
          The amount and the link between sender and recipient stay private
          on-chain, and your money never leaves your control. The proof is built
          on your device; Talise only relays it.
        </p>
      </header>

      {/* Status */}
      <section
        className="rounded-[28px] bg-[#f7fcf2] p-7"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      >
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#CAFFB8]">
            <HugeiconsIcon icon={SquareLock02Icon} className="h-5 w-5 text-[#15300c]" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <h2
                className="text-[clamp(18px,2.4vw,22px)] font-[500] tracking-[-0.05em] text-[#15300c]"
                style={DISPLAY}
              >
                Private payments
              </h2>
              <StatusPill
                label={live ? "Ready" : "Switching on"}
                tone={live ? "active" : "neutral"}
              />
            </div>
            <p className="text-[14px] leading-relaxed text-[#3a5230]">
              {live
                ? "Choose an amount and a recipient to send shielded. Each transaction is capped at " +
                  capUsd +
                  " during the pilot."
                : "The shielded pool is live on Sui mainnet and we're switching on private sends here shortly. Check back soon, your funds stay in your own wallet until then."}
            </p>
          </div>
        </div>
      </section>

      {/* What it does */}
      <section className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <InfoCard
          icon={SquareLock02Icon}
          title="Shielded"
          body="Sender, recipient and amount are hidden on-chain behind a zero-knowledge proof."
          bg="#CAFFB8"
        />
        <InfoCard
          icon={Coins01Icon}
          title="Yours throughout"
          body="Non-custodial. Your money stays in your control the whole time, Talise only relays the proof."
          bg="#FFE59E"
        />
        <InfoCard
          icon={ShieldKeyIcon}
          title="Proof on device"
          body="The proof is generated in your own session. The relayer sponsors gas and never sees your note secrets."
          bg="#C9B8FF"
        />
      </section>

      {/* Honest pilot disclosure */}
      <section
        className="rounded-[28px] bg-[#f7fcf2] p-7"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      >
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          About this pilot
        </h3>
        <ul className="space-y-2.5 text-[14px] leading-relaxed text-[#3a5230]">
          <li className="flex gap-3">
            <Dot />
            <span>
              Early pilot, up to <span className="font-semibold text-[#15300c]">{capUsd}</span> per
              transaction.
            </span>
          </li>
          <li className="flex gap-3">
            <Dot />
            <span>
              The pool&apos;s keys are <span className="font-semibold text-[#15300c]">operator-secured</span>{" "}
              while the fully trustless setup (a multi-party ceremony) and an
              external audit are completed. Send only what you&apos;re comfortable
              with during the pilot.
            </span>
          </li>
          <li className="flex gap-3">
            <Dot />
            <span>Built on Sui, stablecoin transactions on Sui cost nothing.</span>
          </li>
        </ul>
      </section>

      {!live && (
        <p className="px-1 text-center font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Pool published on Sui mainnet
          {SHIELD.poolUsdsui ? "" : " · activation pending"}.
        </p>
      )}
    </div>
  );
}

function InfoCard({
  icon,
  title,
  body,
  bg,
}: {
  icon: typeof SquareLock02Icon;
  title: string;
  body: string;
  bg: string;
}) {
  return (
    <div
      className="rounded-[28px] p-6"
      style={{ background: bg, boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
    >
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#15300c]/[0.08]">
        <HugeiconsIcon icon={icon} className="h-5 w-5 text-[#15300c]" />
      </span>
      <h3
        className="mb-1.5 text-[18px] font-[500] tracking-[-0.05em] text-[#15300c]"
        style={DISPLAY}
      >
        {title}
      </h3>
      <p className="text-[13.5px] leading-relaxed text-[#15300c]/75">{body}</p>
    </div>
  );
}

function Dot() {
  return <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#3d7a29]" />;
}
