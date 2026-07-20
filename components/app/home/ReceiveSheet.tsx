"use client";

/**
 * Receive sheet, shows the user's wallet QR (encoded as `sui:<address>`) plus
 * the @handle / short address and a copy-to-clipboard control. Opened by the
 * "Receive" and "Scan/QR" quick actions on Home. Pure display: no money moves.
 */

import { useState } from "react";
import { publicOrigin } from "@/lib/public-origin";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Sheet, QrImage, useToast, type Me } from "@/components/app";

export function ReceiveSheet({
  open,
  onClose,
  me,
}: {
  open: boolean;
  onClose: () => void;
  me: Me | null;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const address = me?.suiAddress ?? "";
  const handle = me?.taliseHandle ?? "";
  const qrValue = address ? `sui:${address}` : "sui:";
  const short = address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "-";

  // The friendly, on-brand way to get paid: a public pay link to your @handle
  // (the /pay/[handle] page), not a raw 0x address.
  const origin = publicOrigin();
  const payLink = handle ? `${origin}/pay/${handle}` : "";
  const payLinkShort = handle ? `${origin.replace(/^https?:\/\//, "")}/pay/${handle}` : "";

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast("Address copied", "success");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("Couldn't copy address", "danger");
    }
  }

  async function copyLink() {
    if (!payLink) return;
    try {
      await navigator.clipboard.writeText(payLink);
      setCopiedLink(true);
      toast("Payment link copied", "success");
      window.setTimeout(() => setCopiedLink(false), 1600);
    } catch {
      toast("Couldn't copy link", "danger");
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Receive" size="sm">
      <div className="flex flex-col items-center pb-2 text-center">
        <p className="max-w-[18rem] text-[14px] leading-relaxed text-[#3a5230]">
          {me?.taliseHandle ? (
            <>
              Friends can send you USDsui at{" "}
              <span className="font-medium text-[#15300c]">{me.taliseHandle}@talise</span>, or scan this code.
            </>
          ) : (
            "Show this code or share your address to get paid in USDsui. $0.00 fee, lands instantly."
          )}
        </p>

        <div className="mt-5">
          <QrImage value={qrValue} size={208} />
        </div>

        {/* Primary: the friendly @handle pay link. Falls back to the address
            chip when the user hasn't claimed a handle yet. */}
        {payLink ? (
          <button
            type="button"
            onClick={copyLink}
            className="mt-5 inline-flex max-w-full items-center gap-2.5 rounded-full bg-[#15300c] px-4 py-2.5 text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
          >
            <span className="truncate font-mono text-[12px]">{payLinkShort}</span>
            <HugeiconsIcon
              icon={copiedLink ? Tick02Icon : Copy01Icon}
              size={16}
              strokeWidth={2}
            />
          </button>
        ) : null}

        <button
          type="button"
          onClick={copyAddress}
          disabled={!address}
          className="mt-3 inline-flex max-w-full items-center gap-2.5 rounded-full border border-[#15300c]/15 bg-white/60 px-4 py-2 backdrop-blur-sm transition-colors hover:border-[#15300c]/30 active:scale-[0.98] disabled:opacity-50"
        >
          <span className="truncate font-mono text-[12px] text-[#3a5230]">
            {payLink ? "or " : ""}
            {short}
          </span>
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={15}
            strokeWidth={2}
            color={copied ? "#3d7a29" : undefined}
            className={copied ? "" : "text-[#3d7a29]"}
          />
        </button>

        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d7a29]">
          USDsui on Sui · $0.00 fee
        </p>
      </div>
    </Sheet>
  );
}
