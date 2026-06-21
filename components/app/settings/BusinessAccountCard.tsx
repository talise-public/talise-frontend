"use client";

/**
 * BusinessAccountCard — switch between the personal wallet (/app) and the
 * business workspace (/business), and set up a business profile on first use.
 *
 * Model (web/lib/db.ts): a user has one account with an optional business
 * profile (`business_handle`). `account_type` is the ACTIVE context.
 *   • Switch to business → POST /api/account/switch {to:"business"}. If no
 *     profile exists yet the route 400s ("not set up") → we reveal the setup
 *     form, POST /api/account/add-business (which creates the profile AND flips
 *     the context to business), then land on /business.
 *   • Switch to personal → POST /api/account/switch {to:"personal"} → /app.
 * A full navigation (location.href) re-runs the layout gate so the right shell
 * mounts.
 */

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Building06Icon, UserIcon } from "@hugeicons/core-free-icons";
import { GlassCard, Eyebrow, PrimaryButton, api, ApiError, useMe } from "@/components/app";

export function BusinessAccountCard() {
  const { me } = useMe();
  const isBusiness = me?.accountType === "business";

  const [setupOpen, setSetupOpen] = useState(false);
  const [bizName, setBizName] = useState("");
  const [bizHandle, setBizHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(to: "business" | "personal") {
    setBusy(true);
    setError(null);
    try {
      await api("/api/account/switch", { method: "POST", body: { to } });
      window.location.href = to === "business" ? "/business/dashboard" : "/app";
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not switch accounts.";
      if (to === "business" && /not set up/i.test(msg)) {
        setSetupOpen(true);
      } else {
        setError(msg);
      }
      setBusy(false);
    }
  }

  async function createBusiness() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/account/add-business", {
        method: "POST",
        body: { businessName: bizName.trim(), businessHandle: bizHandle.trim().toLowerCase() },
      });
      // add-business also flips account_type to business → land on the dashboard.
      window.location.href = "/business/dashboard";
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not set up the business account.");
      setBusy(false);
    }
  }

  const handleValid =
    bizName.trim().length >= 2 && /^[a-z0-9_]{3,}$/.test(bizHandle.trim().toLowerCase());

  return (
    <section className="space-y-3">
      <Eyebrow>Business</Eyebrow>
      <GlassCard className="divide-y divide-[#15300c]/10 overflow-hidden p-0">

        {/* Info row */}
        <div className="flex items-start gap-3.5 px-5 py-4">
          <span
            className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full text-[#3d7a29]"
            style={{ background: "#CAFFB8" }}
          >
            <HugeiconsIcon
              icon={isBusiness ? UserIcon : Building06Icon}
              size={20}
              strokeWidth={1.8}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-[#15300c]">
              {isBusiness ? "Business workspace" : "Business account"}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-[#3a5230]">
              {isBusiness
                ? "You're in the business workspace: invoices, team payroll, and cash-out. Switch back to your personal wallet any time."
                : "Invoice clients and pay your whole team from a dedicated workspace, on the same balance."}
            </p>
          </div>
        </div>

        {/* Setup form — only visible before the business profile exists */}
        {!isBusiness && setupOpen && (
          <div className="space-y-3 px-5 py-4">
            <label className="block">
              <span className="mb-1.5 block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
                Business name
              </span>
              <input
                value={bizName}
                onChange={(e) => setBizName(e.target.value.slice(0, 64))}
                placeholder="Acme Inc."
                className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:border-[#3d7a29] focus:ring-1 focus:ring-[#3d7a29]/30 transition-colors"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
                Business handle
              </span>
              <input
                value={bizHandle}
                onChange={(e) =>
                  setBizHandle(
                    e.target.value
                      .replace(/[^a-zA-Z0-9_]/g, "")
                      .toLowerCase()
                      .slice(0, 32)
                  )
                }
                placeholder="acme"
                className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-2.5 font-mono text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:border-[#3d7a29] focus:ring-1 focus:ring-[#3d7a29]/30 transition-colors"
              />
              <span className="mt-1.5 block text-[12px] text-[#3d7a29]">
                Clients pay you at @{bizHandle.trim() || "yourbusiness"}.talise.sui
              </span>
            </label>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="px-5 py-3">
            <p className="text-[13px]" style={{ color: "#c0532f" }}>
              {error}
            </p>
          </div>
        )}

        {/* CTA row */}
        <div className="flex items-center gap-2.5 px-5 py-4">
          {isBusiness ? (
            <PrimaryButton
              onClick={() => void switchTo("personal")}
              loading={busy}
              variant="ghost"
            >
              Switch to personal
            </PrimaryButton>
          ) : setupOpen ? (
            <>
              <PrimaryButton
                onClick={() => void createBusiness()}
                disabled={!handleValid || busy}
                loading={busy}
              >
                Create business account
              </PrimaryButton>
              <PrimaryButton
                onClick={() => {
                  setSetupOpen(false);
                  setError(null);
                }}
                variant="ghost"
              >
                Cancel
              </PrimaryButton>
            </>
          ) : (
            <PrimaryButton onClick={() => void switchTo("business")} loading={busy}>
              Switch to business
            </PrimaryButton>
          )}
        </div>

      </GlassCard>
    </section>
  );
}

export default BusinessAccountCard;
