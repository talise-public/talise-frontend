"use client";

/**
 * /app/verify — full-page identity verification (Bridge KYC).
 *
 * Reached from Settings and from the US cash-out flow. Renders the shared
 * <KycFlow> in a focused page column instead of a modal.
 */

import { useRouter } from "next/navigation";
import { Eyebrow, PrimaryButton } from "@/components/app";
import { BackButton } from "@/components/app/ui/BackButton";
import { KycFlow } from "@/components/app/ramps/KycFlow";

export default function VerifyPage() {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-lg space-y-6 pb-16 pt-2">
      <div className="space-y-3">
        <BackButton />
        <div>
          <Eyebrow>Identity</Eyebrow>
          <h1
            className="mt-1 text-[clamp(24px,4.5vw,34px)] font-[500] leading-[1.05] tracking-[-0.05em] text-[#15300c]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
          >
            Verify your identity
          </h1>
        </div>
      </div>

      <div
        className="rounded-[28px] bg-[#f7fcf2] p-6 sm:p-8"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      >
        <KycFlow
          approvedCta={
            <PrimaryButton full onClick={() => router.push("/app/ramps")}>
              Back to ramps
            </PrimaryButton>
          }
        />
      </div>
    </div>
  );
}
