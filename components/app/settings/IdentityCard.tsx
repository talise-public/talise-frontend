"use client";

/**
 * IdentityCard — Bridge KYC status in Settings.
 *
 * Shows the current verification status and links to /app/verify to start or
 * finish KYC. Hidden entirely when Bridge KYC isn't configured (503).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ShieldUserIcon,
  CheckmarkBadge02Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { GlassCard, Eyebrow, StatusPill, Spinner, api, ApiError } from "@/components/app";

type StatusResp = {
  started: boolean;
  status: string;
  kycStatus?: string;
  tosStatus?: string;
  stale?: boolean;
};

function pill(status?: string): { text: string; tone: "success" | "danger" | "pending" | "neutral" } {
  const s = (status ?? "").toLowerCase();
  if (s === "approved") return { text: "Verified", tone: "success" };
  if (["rejected", "declined", "expired", "canceled", "cancelled"].includes(s))
    return { text: "Action needed", tone: "danger" };
  if (["pending", "under_review", "in_review", "processing", "active"].includes(s))
    return { text: "In review", tone: "pending" };
  return { text: "Not verified", tone: "neutral" };
}

export function IdentityCard() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<StatusResp>("/api/kyc/bridge/status")
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e) => {
        // Bridge not configured → hide the section entirely.
        if (!cancelled && e instanceof ApiError && e.status === 503) setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unavailable) return null;

  const approved = (status?.status ?? "").toLowerCase() === "approved";
  const p = pill(status?.status);

  return (
    <section className="space-y-3">
      <Eyebrow>Identity</Eyebrow>
      <GlassCard className="overflow-hidden p-0">
        <Link
          href="/app/verify"
          className="flex w-full items-center gap-3.5 px-5 py-4 transition-colors hover:bg-[#CAFFB8]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/40"
        >
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-[#3d7a29]"
            style={{ background: "#CAFFB8" }}
          >
            <HugeiconsIcon
              icon={approved ? CheckmarkBadge02Icon : ShieldUserIcon}
              size={20}
              strokeWidth={1.8}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-[#15300c]">
              Identity verification
            </span>
            <span className="block truncate text-[13px] text-[#3d7a29]">
              {approved
                ? "You're verified for US bank cash-out."
                : "Verify your identity to cash out to a US bank."}
            </span>
          </span>
          {loading ? <Spinner size={15} /> : <StatusPill label={p.text} tone={p.tone} />}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className="text-[#3d7a29]" />
        </Link>
      </GlassCard>
    </section>
  );
}

export default IdentityCard;
