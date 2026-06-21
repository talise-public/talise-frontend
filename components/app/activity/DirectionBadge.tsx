import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRightIcon,
  ArrowDownLeftIcon,
  PlantIcon,
  ArrowDataTransferHorizontalIcon,
  Coins01Icon,
} from "@hugeicons/core-free-icons";
import type { Category } from "./types";

/**
 * Directional palette — v2 brand-fill treatment. The disc is a solid brand
 * fill and the glyph sits in a deep ink so it reads on the coloured disc:
 *   sent     → coral fill, muted-coral glyph   (outflow)
 *   received → mint fill, forest glyph          (inflow credit)
 *   withdraw → mint fill, forest glyph          (pool → wallet credit)
 *   invest   → mint fill, forest glyph          (yield motion)
 *   swap     → mint fill, forest glyph          (system/DEX conversion)
 *   neutral  → mint disc, brand-ink glyph
 */
// v2 directional palette. Outflow (sent) uses the coral brand fill with the
// muted-coral ink glyph; all inflow/system motions use the mint brand fill
// with the deep-forest glyph. Neutral falls back to a pale glass mint disc.
const CORAL = "#FF9E7A";
const CORAL_FG = "#c0532f";
const MINT = "#CAFFB8";
const GREEN_FG = "#3d7a29";

export type BadgeStyle = {
  bg: string;
  fg: string;
  icon: typeof ArrowUpRightIcon;
};

export function badgeStyle(category: Category): BadgeStyle {
  switch (category) {
    case "sent":
      return {
        bg: CORAL,
        fg: CORAL_FG,
        icon: ArrowUpRightIcon,
      };
    case "received":
      return {
        bg: MINT,
        fg: GREEN_FG,
        icon: ArrowDownLeftIcon,
      };
    case "withdraw":
      return {
        bg: MINT,
        fg: GREEN_FG,
        icon: PlantIcon,
      };
    case "invest":
      return {
        bg: MINT,
        fg: GREEN_FG,
        icon: PlantIcon,
      };
    case "swap":
      return {
        bg: MINT,
        fg: GREEN_FG,
        icon: ArrowDataTransferHorizontalIcon,
      };
    default:
      return {
        bg: "#CAFFB8",
        fg: "#15300c",
        icon: Coins01Icon,
      };
  }
}

/** The directional tint used on row hover/press (transparent for neutral). */
export function tintColor(category: Category): string | null {
  switch (category) {
    case "sent":
      return CORAL_FG;
    case "received":
    case "withdraw":
      return "#3d7a29";
    case "invest":
    case "swap":
      return "#3d7a29";
    default:
      return null;
  }
}

export function DirectionBadge({
  category,
  size = 36,
  iconSize,
}: {
  category: Category;
  size?: number;
  iconSize?: number;
}) {
  const s = badgeStyle(category);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, background: s.bg }}
    >
      <HugeiconsIcon
        icon={s.icon}
        size={iconSize ?? Math.round(size * 0.42)}
        color={s.fg}
        strokeWidth={2}
      />
    </span>
  );
}
