import Link from "next/link";
import { SHIELD, shieldConfigured, shieldMaintenance } from "@/lib/shield/onchain";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { DiscloseClient } from "./disclose-client";

export const dynamic = "force-dynamic";

const DISPLAY = {
  fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
} as const;

/**
 * /app/private/disclose — selective disclosure for shielded payments.
 *
 * Two things a regulated payments business needs and privacy alone does not
 * give it:
 *   1. PROVE a specific shielded payment happened, to a counterparty or an
 *      auditor, without publishing everything else.
 *   2. CHECK such a proof when someone hands you one.
 *
 * Both run entirely in the browser (see disclose-client.tsx). The verify panel
 * in particular talks to a Sui fullnode the reader chooses and to no Talise
 * endpoint, which is the whole point: a disclosure must be checkable WITHOUT
 * trusting us.
 *
 * SHIPS DARK. `shieldMaintenance()` is the gate, same as the send path: while it
 * is on, this page is an explanation and nothing more. The API routes under
 * /api/shield/disclose/** 503 behind the same flag.
 */
export default function DisclosePage() {
  const maint = shieldMaintenance();
  const live = shieldConfigured() && !maint;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-7 pb-10 pt-1">
      <header className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Private · Disclosure
        </p>
        <h1
          className="max-w-xl text-[clamp(26px,5.4vw,40px)] font-[500] leading-[1.0] tracking-[-0.05em] text-[#15300c]"
          style={DISPLAY}
        >
          Prove a private payment.
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-[#3a5230]">
          A shielded payment hides the amount from everyone. Selective disclosure
          lets you show one payment to one party — an auditor, a counterparty, a
          regulator — and prove the amount, without revealing anything else you
          have ever sent or received.
        </p>
        <p className="max-w-xl text-[14px] leading-relaxed text-[#3a5230]">
          The proof is the note&apos;s own secret. Anyone can check it against Sui
          directly, so they never have to trust Talise for the answer.{" "}
          <Link href="/app/private" className="underline decoration-[#8fc47a] underline-offset-2">
            Back to private sends
          </Link>
        </p>
      </header>

      {maint ? (
        <section
          className="rounded-[28px] bg-[#f7fcf2] p-7"
          style={{
            boxShadow:
              "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)",
          }}
        >
          <h2
            className="mb-2 text-[19px] font-[500] tracking-[-0.04em] text-[#15300c]"
            style={DISPLAY}
          >
            Not switched on yet
          </h2>
          <p className="text-[14px] leading-relaxed text-[#3a5230]">
            Private sends are in maintenance, so there is nothing to disclose yet.
            Disclosure ships with them.
          </p>
        </section>
      ) : null}

      <DiscloseClient
        live={live}
        packageId={SHIELD.packageId ?? ""}
        poolObjectId={SHIELD.poolUsdsui ?? ""}
        coinType={USDSUI_TYPE}
        amountDecimals={6}
      />

      {/* The honest part. Deliberately not collapsible. */}
      <section
        className="rounded-[28px] bg-[#f7fcf2] p-7"
        style={{
          boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)",
        }}
      >
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          What a disclosure costs you
        </h3>
        <ul className="space-y-2.5 text-[14px] leading-relaxed text-[#3a5230]">
          <li className="flex gap-3">
            <Dot />
            <span>
              <span className="font-semibold text-[#15300c]">It is permanent.</span>{" "}
              Disclosing a note deanonymises that note, by design. Whoever holds
              the receipt can link its amount to an on-chain commitment forever.
              There is no revocation — once revealed, revealed.
            </span>
          </li>
          <li className="flex gap-3">
            <Dot />
            <span>
              <span className="font-semibold text-[#15300c]">It proves an amount, not a story.</span>{" "}
              A receipt does not prove who sent the money, does not prove the note
              is still unspent, and does not prove who controls the owner key.
            </span>
          </li>
          <li className="flex gap-3">
            <Dot />
            <span>
              <span className="font-semibold text-[#15300c]">
                Only the notes you list are revealed.
              </span>{" "}
              Everything else stays shielded. But a receipt is also not proof of
              completeness: it says nothing about the notes you did not list.
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}

function Dot() {
  return (
    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#8fc47a]" aria-hidden />
  );
}
