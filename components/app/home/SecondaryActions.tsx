"use client";

/**
 * SecondaryActions, the compact row under the Home balance card. The two
 * primary actions (Send / Request) live inline inside the BalanceCard; this row
 * keeps the remaining quick actions (Add money, Receive) reachable without
 * adding weight to the card. Receive opens the QR/handle sheet inline; Add money
 * links to the on/off ramps. Soft-mint quiet buttons.
 */

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { CreditCardIcon, QrCode01Icon, Coins01Icon } from "@hugeicons/core-free-icons";
import { type Me } from "@/components/app";
import { ReceiveSheet } from "./ReceiveSheet";
import { TokenBucketSheet } from "./TokenBucketSheet";

// whitespace-nowrap + tighter mobile padding/gap so the longest label
// ("Add money") stays on ONE line inside its third-width grid cell instead of
// wrapping to two lines. Roomier padding returns at sm+ where width is ample.
const BTN =
  "inline-flex items-center justify-center gap-1.5 sm:gap-2 whitespace-nowrap rounded-[4px] border border-[rgba(18,26,15,0.14)] bg-white px-3 sm:px-5 py-2.5 text-[11px] uppercase tracking-[0.06em] text-[#55634e] font-mono transition-colors hover:border-[rgba(18,26,15,0.3)] hover:text-[#121a0f] active:scale-[0.98] outline-none focus-visible:ring-2 focus-visible:ring-[#2f6a1f]/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#edf0ea]";

export function SecondaryActions({ me }: { me: Me | null }) {
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);

  return (
    <>
      <div className="grid grid-cols-3 gap-2.5 sm:flex sm:flex-wrap">
        <Link href="/app/ramps" className={BTN}>
          <HugeiconsIcon icon={CreditCardIcon} size={16} strokeWidth={2} color="currentColor" className="shrink-0" />
          Add money
        </Link>
        <button type="button" onClick={() => setReceiveOpen(true)} className={BTN}>
          <HugeiconsIcon icon={QrCode01Icon} size={16} strokeWidth={2} color="currentColor" className="shrink-0" />
          Receive
        </button>
        <button type="button" onClick={() => setTokensOpen(true)} className={BTN}>
          <HugeiconsIcon icon={Coins01Icon} size={16} strokeWidth={2} color="currentColor" className="shrink-0" />
          Tokens
        </button>
      </div>
      <ReceiveSheet open={receiveOpen} onClose={() => setReceiveOpen(false)} me={me} />
      <TokenBucketSheet open={tokensOpen} onClose={() => setTokensOpen(false)} />
    </>
  );
}
