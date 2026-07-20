"use client";

/**
 * Quick-actions row: Send, Receive, Scan. Each is a glass tile with a mint-
 * tinted icon disc. Send → the Pay flow. Receive opens the Receive sheet (pay
 * link + QR). Scan opens the camera scanner (mobile only).
 *
 * Mobile: a 3-up grid (icon over a short label). Desktop: 2-up (Scan hidden -
 * no camera, and showing your own QR isn't "scanning").
 */

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  SentIcon,
  QrCode01Icon,
  ScanIcon,
} from "@hugeicons/core-free-icons";
import dynamic from "next/dynamic";
import { type Me } from "@/components/app";
import { ReceiveSheet } from "./ReceiveSheet";

// The scanner pulls in jsQR + the camera plumbing, only load it when the user
// actually taps Scan, keeping it out of the initial bundle.
const ScanSheet = dynamic(() => import("./ScanSheet").then((m) => ({ default: m.ScanSheet })), {
  ssr: false,
});

type TileProps = {
  icon: IconSvgElement;
  label: string;
  sublabel: string;
  href?: string;
  onClick?: () => void;
  badge?: string;
  className?: string;
};

function ActionTile({ icon, label, sublabel, href, onClick, badge, className = "" }: TileProps) {
  const inner = (
    <>
      <span
        className="flex size-9 items-center justify-center rounded-xl text-[#15300c] sm:size-11 sm:rounded-xl"
        style={{ background: "#CAFFB8" }}
      >
        <HugeiconsIcon icon={icon} size={19} strokeWidth={1.9} color="#15300c" />
      </span>
      <span className="mt-2 flex min-w-0 flex-col sm:mt-2.5">
        <span className="truncate text-[13px] font-medium leading-tight text-[#15300c] sm:text-[14px]">
          {label}
        </span>
        {/* Sublabel only on >=sm, on a 4-up mobile row it wraps ("Pay / anyone")
            and looks broken; the label alone reads clean. */}
        <span className="mt-0.5 hidden text-[11px] leading-tight text-[#3d7a29] sm:block">
          {sublabel}
        </span>
      </span>
      {badge && (
        <span className="absolute right-2.5 top-2.5 rounded-full border border-[#15300c]/15 bg-white/60 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-[#3d7a29] backdrop-blur-sm sm:text-[9px]">
          {badge}
        </span>
      )}
    </>
  );

  const cls =
    `relative flex flex-col items-start rounded-[20px] border border-[#15300c]/15 bg-white/60 px-3 py-3 text-left backdrop-blur-sm transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-[#15300c]/30 active:translate-y-0 active:scale-[0.98] sm:px-3.5 sm:py-4 ${className}`;

  if (href) {
    return (
      <Link href={href} className={cls} aria-label={label}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls} aria-label={label}>
      {inner}
    </button>
  );
}

export function QuickActions({ me }: { me: Me | null }) {
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  return (
    <>
      {/* Mobile: Send · Receive · Scan (3-up). Desktop: Send · Receive (Scan
          hidden, no camera, and showing your own QR isn't "scanning"). */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3 lg:grid-cols-2">
        <ActionTile icon={SentIcon} label="Send" sublabel="Pay anyone" href="/app/pay" />
        <ActionTile
          icon={QrCode01Icon}
          label="Receive"
          sublabel="Get paid"
          onClick={() => setReceiveOpen(true)}
        />
        <ActionTile
          icon={ScanIcon}
          label="Scan"
          sublabel="QR to pay"
          onClick={() => setScanOpen(true)}
          className="lg:hidden"
        />
      </div>

      <ReceiveSheet open={receiveOpen} onClose={() => setReceiveOpen(false)} me={me} />
      <ScanSheet open={scanOpen} onClose={() => setScanOpen(false)} />
    </>
  );
}
