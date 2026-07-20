"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SmartPhone01Icon,
  GiftIcon,
  Coins01Icon,
  SparklesIcon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import {
  GlassCard,
  MicroLabel,
  PrimaryButton,
  Sheet,
  api,
  ApiError,
  useToast,
} from "@/components/app";
import type { CatalogueItem } from "./types";

/**
 * Map the catalogue's SF-Symbol `icon` string (e.g. "phone.fill") to a
 * Hugeicon. Falls back to a gift glyph so a new SKU never renders blank.
 */
function iconFor(item: CatalogueItem): typeof GiftIcon {
  const i = item.icon ?? "";
  if (i.startsWith("phone")) return SmartPhone01Icon;
  if (i.includes("coin") || i.includes("dollar")) return Coins01Icon;
  if (i.includes("spark") || i.includes("star")) return SparklesIcon;
  return GiftIcon;
}

/** Human label for a tier id, for the "Unlocks at <tier>" hint. */
const TIER_LABEL: Record<string, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  plat: "Platinum",
};

/** Map a redeem error code → a friendly inline/toast message. */
function redeemMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "insufficient_points":
        return "You don't have enough points for this yet.";
      case "debounced":
        return "Hang on a moment before redeeming again.";
      case "already_active":
        return "You already have this perk active.";
      case "sku_disabled":
        return "This perk is no longer available.";
      case "unknown_sku":
        return "That perk could not be found.";
      default:
        return err.message || "Could not redeem. Please try again.";
    }
  }
  return "Could not redeem. Please try again.";
}

/**
 * The redemption catalogue: a responsive grid of perk cards. Each card
 * shows the perk, its point cost, and a Redeem button that's disabled
 * with an "X pts needed" hint when the user can't afford it. Tapping
 * Redeem opens a confirm Sheet; on success we toast + refresh the parent.
 */
export function Redemptions({
  items,
  pointsTotal,
  onRedeemed,
}: {
  items: CatalogueItem[];
  pointsTotal: number;
  onRedeemed: () => void;
}) {
  const { toast } = useToast();
  const [active, setActive] = useState<CatalogueItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/rewards/redeem", { method: "POST", body: { sku: active.sku } });
      toast(`Redeemed, ${active.label}`, "success");
      setActive(null);
      onRedeemed();
    } catch (err) {
      const msg = redeemMessage(err);
      setError(msg);
      toast(msg, "danger");
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <section className="space-y-2.5">
        <MicroLabel>Redeem your points</MicroLabel>
        <GlassCard className="px-5 py-7 text-center">
          <p className="text-[13px] text-[#3a5230]">New perks are on the way.</p>
          <p className="mt-1 text-[12px] text-[#3d7a29]">
            Keep earning, your points are banked and ready.
          </p>
        </GlassCard>
      </section>
    );
  }

  return (
    <section className="space-y-2.5">
      <MicroLabel>Redeem your points</MicroLabel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <PerkCard
            key={item.sku}
            item={item}
            pointsTotal={pointsTotal}
            onRedeem={() => {
              setError(null);
              setActive(item);
            }}
          />
        ))}
      </div>

      <Sheet
        open={!!active}
        onClose={() => {
          if (!busy) setActive(null);
        }}
        title="Confirm redemption"
        size="sm"
      >
        {active && (
          <div className="space-y-4 pt-1">
            {/* Perk summary row */}
            <div className="flex items-center gap-3.5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#CAFFB8] text-[#15300c]">
                <HugeiconsIcon icon={iconFor(active)} size={22} strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-[#15300c]">{active.label}</p>
                <p className="text-[12px] text-[#3d7a29]">{active.description}</p>
              </div>
            </div>

            {/* Cost + balance-after rows */}
            <GlassCard className="overflow-hidden !p-0" radius={20}>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[13px] text-[#3a5230]">Cost</span>
                <span className="text-[14px] font-medium text-[#3d7a29] tabular-nums">
                  {active.pointsCost.toLocaleString()} pts
                </span>
              </div>
              <div className="mx-4 h-px bg-[#15300c]/10" />
              <div className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-[11px] text-[#3d7a29]">Balance after</span>
                <span className="font-mono text-[11px] tabular-nums text-[#3d7a29]">
                  {Math.max(0, pointsTotal - active.pointsCost).toLocaleString()} pts
                </span>
              </div>
            </GlassCard>

            {active.kind === "pending" && (
              <p className="text-[12px] text-[#3d7a29]">
                We&apos;ll fulfill this within 24 hours and notify you when it&apos;s done.
              </p>
            )}

            {error && <p className="text-[13px] text-[#c0532f]">{error}</p>}

            <div className="flex gap-3">
              <PrimaryButton variant="ghost" onClick={() => setActive(null)} disabled={busy}>
                Cancel
              </PrimaryButton>
              <PrimaryButton onClick={confirm} loading={busy} full>
                Redeem
              </PrimaryButton>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
}

function PerkCard({
  item,
  pointsTotal,
  onRedeem,
}: {
  item: CatalogueItem;
  pointsTotal: number;
  onRedeem: () => void;
}) {
  // Shown only when !canAfford, the gap between cost and the user's balance.
  const shortfall = Math.max(0, item.pointsCost - pointsTotal);
  return (
    <GlassCard className="flex flex-col gap-3.5 p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={iconFor(item)} size={20} strokeWidth={1.8} />
        </span>
        <span className="flex items-baseline gap-1 font-mono text-[#3d7a29]">
          <span className="text-[14px] font-medium tabular-nums">
            {item.pointsCost.toLocaleString()}
          </span>
          <span className="text-[10px] text-[#3d7a29]">pts</span>
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-[#15300c]">{item.label}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-[#3d7a29]">{item.description}</p>
      </div>

      {item.minTier ? (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-[#3d7a29]">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={1.8} />
          Unlocks at {TIER_LABEL[item.minTier] ?? item.minTier}
        </div>
      ) : item.canAfford ? (
        <PrimaryButton onClick={onRedeem} full>
          Redeem
        </PrimaryButton>
      ) : (
        <PrimaryButton variant="ghost" disabled full>
          {shortfall.toLocaleString()} pts needed
        </PrimaryButton>
      )}
    </GlassCard>
  );
}
