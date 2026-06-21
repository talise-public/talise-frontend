"use client";

import { type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
};

const MAX_W = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-lg" } as const;

/**
 * Modal surface built on Radix Dialog — a bottom sheet on mobile, a centered
 * glass dialog on sm+. Radix gives us focus-trap, scroll-lock, ESC + backdrop
 * close, focus restoration, and the right ARIA roles for free; the look (glass
 * panel, grab handle, eyebrow title, soft green scrim) is unchanged. Controlled
 * via `open` / `onClose`, so no consumer changes.
 */
export function Sheet({ open, onClose, title, children, size = "md" }: SheetProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        {/* Backdrop — soft dark-green scrim (not pure black) + light blur. */}
        <Dialog.Overlay
          className="talise-sheet-backdrop fixed inset-0 z-[100] backdrop-blur-sm data-[state=closed]:opacity-0"
          style={{ background: "rgba(21,48,12,0.35)" }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          // Don't yank focus into the first input (pops the mobile keyboard);
          // Radix still traps focus within the panel.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={`talise-sheet-panel fixed inset-x-0 bottom-0 z-[101] mx-auto w-full border border-[#15300c]/10 bg-[#f7fcf2] text-[#15300c] outline-none ${MAX_W[size]} sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2`}
          style={{ borderRadius: 24, maxHeight: "92vh", boxShadow: "0 24px 60px -20px rgba(21,48,12,0.45)" }}
        >
          {/* Mobile grab handle */}
          <div className="flex justify-center pt-2.5 sm:hidden">
            <span className="h-1 w-10 rounded-full bg-[#15300c]/15" />
          </div>

          <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-3 sm:pt-5">
            {title ? (
              <Dialog.Title className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
                {title}
              </Dialog.Title>
            ) : (
              <Dialog.Title className="sr-only">Dialog</Dialog.Title>
            )}
            <Dialog.Close
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-full text-[#3d7a29] outline-none transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c] focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={2} />
            </Dialog.Close>
          </div>

          <div className="overflow-y-auto px-5 pb-6" style={{ maxHeight: "calc(92vh - 56px)" }}>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
