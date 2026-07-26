"use client";

/**
 * KycFlow — Bridge hosted identity verification, as an inline (page) flow.
 *
 * Shared by the /app/verify page and the US cash-out page's KYC gate. Bridge
 * runs identity + Terms in a hosted flow; we open those links in a new tab and
 * poll our own status route (no PII passes through Talise).
 *
 *   1. start   POST /api/kyc/bridge/start → { kycUrl, tosUrl }. Open kycUrl in
 *              a new tab. Apple private-relay email → 409, ask for a real one.
 *   2. poll    GET /api/kyc/bridge/status every 8s (and on tab refocus) until
 *              status === "approved" (calls onApproved) or a terminal state.
 *   3. steps   while pending, surface whichever hosted step remains.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Alert02Icon,
  Clock01Icon,
  ShieldUserIcon,
} from "@hugeicons/core-free-icons";
import { PrimaryButton, Field, api, ApiError } from "@/components/app";

type StartResp = {
  provider: string;
  status: string;
  kycUrl: string;
  tosUrl: string;
  kycLinkId: string;
  customerId: string;
};

type StatusResp =
  | { started: false; status: string }
  | {
      started: true;
      status: string;
      kycStatus?: string;
      tosStatus?: string;
      customerId?: string;
      kycUrl?: string;
      tosUrl?: string;
      stale?: boolean;
    };

const DONE = (s?: string) =>
  !!s && ["approved", "active", "accepted", "complete", "completed"].includes(s.toLowerCase());
const TERMINAL_BAD = (s?: string) =>
  !!s && ["rejected", "declined", "expired", "canceled", "cancelled"].includes(s.toLowerCase());

const openHosted = (url?: string) => {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
};

export function KycFlow({
  onApproved,
  approvedCta,
}: {
  onApproved?: () => void;
  /** Rendered under the "verified" card (e.g. a "Back to ramps" button). */
  approvedCta?: ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [links, setLinks] = useState<{ kycUrl?: string; tosUrl?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [needEmail, setNeedEmail] = useState(false);
  const [email, setEmail] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approvedFired = useRef(false);

  const approved = DONE(status?.status);
  const started = status?.started === true;
  const terminalBad = TERMINAL_BAD(status?.status);
  const pending = !!status && started && !approved && !terminalBad;
  const kycStepDone = DONE(status && "kycStatus" in status ? status.kycStatus : undefined);
  const tosStepDone = DONE(status && "tosStatus" in status ? status.tosStatus : undefined);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api<StatusResp>("/api/kyc/bridge/status");
      setStatus(s);
      if (s.started && (s.kycUrl || s.tosUrl)) {
        setLinks((prev) => ({
          kycUrl: s.kycUrl ?? prev.kycUrl,
          tosUrl: s.tosUrl ?? prev.tosUrl,
        }));
      }
      return s;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 503)) {
        setError(e.message);
      }
      return null;
    }
  }, []);

  // Load status on mount.
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchStatus().finally(() => setLoading(false));
  }, [fetchStatus]);

  // Fire onApproved exactly once.
  useEffect(() => {
    if (approved && !approvedFired.current) {
      approvedFired.current = true;
      onApproved?.();
    }
  }, [approved, onApproved]);

  // Poll every 8s while pending.
  useEffect(() => {
    if (!pending) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(fetchStatus, 8000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [pending, fetchStatus]);

  // Re-check on tab refocus (they just came back from the hosted flow).
  useEffect(() => {
    const onFocus = () => {
      if (!approvedFired.current) fetchStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchStatus]);

  const begin = useCallback(
    async (withEmail?: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await api<StartResp>("/api/kyc/bridge/start", {
          method: "POST",
          body: withEmail ? { email: withEmail } : {},
        });
        setLinks({ kycUrl: r.kycUrl, tosUrl: r.tosUrl });
        setNeedEmail(false);
        openHosted(r.kycUrl);
        await fetchStatus();
      } catch (e) {
        if (e instanceof ApiError && e.code === "REAL_EMAIL_REQUIRED") {
          setNeedEmail(true);
        } else if (e instanceof ApiError && e.code === "REAL_EMAIL_INVALID") {
          setNeedEmail(true);
          setError("That email doesn't look right. Try another.");
        } else if (e instanceof ApiError && e.code === "RATE_LIMITED") {
          setError("Too many attempts. Give it a moment and try again.");
        } else {
          setError(e instanceof ApiError ? e.message : "Couldn't start verification.");
        }
      } finally {
        setBusy(false);
      }
    },
    [fetchStatus],
  );

  const kycUrl = links.kycUrl;
  const tosUrl = links.tosUrl;

  if (loading) {
    return <p className="py-6 text-center text-[14px] text-[#3d7a29]">Checking your status…</p>;
  }
  if (approved) {
    return (
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <Badge tone="success" icon={CheckmarkCircle02Icon} />
        <div>
          <h3 className="text-[18px] font-medium tracking-[-0.05em] text-[#15300c]">You&apos;re verified</h3>
          <p className="mt-1 max-w-sm text-[14px] leading-relaxed text-[#3a5230]">
            Your identity is confirmed. You can cash out to your US bank.
          </p>
        </div>
        {approvedCta}
      </div>
    );
  }
  if (terminalBad) {
    return (
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <Badge tone="error" icon={Alert02Icon} />
        <div>
          <h3 className="text-[18px] font-medium tracking-[-0.05em] text-[#15300c]">
            Verification didn&apos;t go through
          </h3>
          <p className="mt-1 max-w-sm text-[14px] leading-relaxed text-[#3a5230]">
            Your last attempt wasn&apos;t approved. Make sure your name matches your government ID, then try again.
          </p>
        </div>
        <PrimaryButton full onClick={() => begin()} loading={busy}>
          Try again
        </PrimaryButton>
      </div>
    );
  }
  if (needEmail) {
    return (
      <div className="space-y-5">
        <p className="text-[14px] leading-relaxed text-[#3a5230]">
          Your account uses a private Apple relay email, which identity checks can&apos;t use. Add a
          real email to continue — it&apos;s only used for verification.
        </p>
        <Field label="Email">
          <input
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.trim())}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-[16px] text-[#15300c] placeholder:text-[#3d7a29] outline-none backdrop-blur-sm focus:border-[#3d7a29] focus:ring-1 focus:ring-[#3d7a29]"
          />
        </Field>
        {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}
        <PrimaryButton
          full
          onClick={() => begin(email)}
          disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)}
          loading={busy}
        >
          Continue
        </PrimaryButton>
      </div>
    );
  }
  if (pending) {
    return (
      <div className="space-y-5">
        <div
          className="flex items-start gap-3.5 rounded-[24px] bg-[#f7fcf2] p-5"
          style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
        >
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-[#FFE59E] text-[#15300c]">
            <HugeiconsIcon icon={Clock01Icon} size={18} strokeWidth={2} />
          </span>
          <div>
            <h3 className="text-[16px] font-medium tracking-[-0.03em] text-[#15300c]">
              {kycStepDone && !tosStepDone ? "One more step" : "We're reviewing your details"}
            </h3>
            <p className="mt-1 text-[13.5px] leading-relaxed text-[#3a5230]">
              {kycStepDone && !tosStepDone
                ? "Your identity is in — accept the terms of service to finish."
                : "This usually takes a few minutes. You can keep this open; it updates on its own."}
            </p>
          </div>
        </div>
        {!kycStepDone && kycUrl && (
          <PrimaryButton full onClick={() => openHosted(kycUrl)}>
            Continue verification
          </PrimaryButton>
        )}
        {kycStepDone && !tosStepDone && tosUrl && (
          <PrimaryButton full onClick={() => openHosted(tosUrl)}>
            Accept terms
          </PrimaryButton>
        )}
        <button
          type="button"
          onClick={() => fetchStatus()}
          className="mx-auto block text-[13px] text-[#3a5230] underline-offset-2 hover:underline"
        >
          Refresh status
        </button>
        {error && <p className="text-center text-[13px] text-[#c0532f]">{error}</p>}
      </div>
    );
  }
  // Not started.
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <Badge tone="neutral" icon={ShieldUserIcon} />
        <div>
          <h3 className="text-[18px] font-medium tracking-[-0.05em] text-[#15300c]">A quick identity check</h3>
          <p className="mt-1 max-w-sm text-[14px] leading-relaxed text-[#3a5230]">
            US bank cash-out requires a one-time identity verification, handled securely by our partner
            Bridge. It takes a couple of minutes.
          </p>
        </div>
      </div>
      {error && <p className="text-center text-[13px] text-[#c0532f]">{error}</p>}
      <PrimaryButton full onClick={() => begin()} loading={busy}>
        Verify identity
      </PrimaryButton>
      <p className="text-center text-[12px] text-[#3d7a29]">Opens a secure Bridge window in a new tab.</p>
    </div>
  );
}

function Badge({ tone, icon }: { tone: "success" | "error" | "neutral"; icon: typeof CheckmarkCircle02Icon }) {
  const bg = tone === "error" ? "bg-[#FF9E7A]" : "bg-[#CAFFB8]";
  const fg = tone === "error" ? "text-[#c0532f]" : "text-[#15300c]";
  return (
    <span className={`flex size-12 items-center justify-center rounded-full ${bg} ${fg}`}>
      <HugeiconsIcon icon={icon} size={24} strokeWidth={2} />
    </span>
  );
}

export default KycFlow;
