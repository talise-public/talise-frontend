"use client";

/**
 * AtomicFlowReceipt — "what happened in one transaction" card.
 *
 * Talise sends are a single sponsored PTB that can bundle a payment, a round-up
 * Save into NAVI, and an on-chain receipt — all in ONE signature, no wallet
 * prompt, no gas. The plain success screen hid that; this card surfaces the
 * real legs as a compact checklist so the atomic composability is visible.
 *
 * Every row is derived ONLY from real data passed in by the caller — we never
 * fabricate a step that didn't run (the Save row only appears when the server
 * actually supplied a round-up leg). Reusable for Earn/Cheque success later via
 * the typed props.
 */

import { motion, useReducedMotion, type Transition } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";

const EXPLORER = "https://suiscan.xyz/mainnet/tx/";

export type AtomicFlowReceiptProps = {
  /** Already-formatted paid amount incl. currency symbol, e.g. "$12.50". */
  amountText: string;
  /** Recipient display name / handle the payment went to. */
  recipientDisplay: string;
  /** Already-formatted round-up amount incl. symbol (e.g. "$0.50"); omit/empty when no Save leg ran. */
  savedText?: string;
  /** On-chain transaction digest — links to the explorer. */
  digest: string;
};

/** A single soft-mint check disc + one line of plain copy. */
function StepRow({
  text,
  emphasis,
  index,
  reduce,
}: {
  text: React.ReactNode;
  emphasis?: React.ReactNode;
  index: number;
  reduce: boolean | null;
}) {
  // ~60ms stagger so the legs reveal in order; reduced-motion → no movement.
  const transition: Transition = reduce
    ? { duration: 0 }
    : { duration: 0.28, delay: 0.06 * index, ease: [0.22, 1, 0.36, 1] };

  return (
    <motion.li
      className="flex items-start gap-2.5"
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8]">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          size={13}
          color="#3d7a29"
          strokeWidth={2.2}
        />
      </span>
      <span className="text-[13px] leading-5 text-[#15300c]">
        {text}
        {emphasis ? <span className="font-mono text-[#3a5230]"> {emphasis}</span> : null}
      </span>
    </motion.li>
  );
}

export function AtomicFlowReceipt({
  amountText,
  recipientDisplay,
  savedText,
  digest,
}: AtomicFlowReceiptProps) {
  const reduce = useReducedMotion();
  const hasSave = !!savedText && savedText.trim().length > 0;
  const explorerUrl = `${EXPLORER}${digest}`;

  // Build the step list from real data only. The Save row is conditional; the
  // paid + receipt rows always ran. `index` keeps the stagger sequential.
  const steps: { text: React.ReactNode; emphasis?: React.ReactNode }[] = [
    {
      text: (
        <>
          Paid <span className="font-mono">{amountText}</span> to{" "}
          <span className="text-[#15300c]">{recipientDisplay}</span>
        </>
      ),
    },
  ];
  if (hasSave) {
    steps.push({
      text: (
        <>
          Rounded up <span className="font-mono">{savedText}</span> → earning in NAVI
        </>
      ),
    });
  }
  steps.push({ text: <>Receipt recorded on-chain</> });

  return (
    <div className="w-full rounded-[28px] border border-[#15300c]/15 bg-white/60 px-5 py-4 text-left backdrop-blur-sm">
      {/* Header: the POINT — every leg above landed in a single signature. */}
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#3d7a29]">
          1 atomic transaction
        </span>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[10px] text-[#3d7a29] transition-colors hover:text-[#15300c]"
        >
          View on SuiVision
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
        </a>
      </div>

      <ul className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <StepRow key={i} text={s.text} emphasis={s.emphasis} index={i} reduce={reduce} />
        ))}
      </ul>
    </div>
  );
}

export default AtomicFlowReceipt;
