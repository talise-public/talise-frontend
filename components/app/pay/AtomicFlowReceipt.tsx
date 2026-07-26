"use client";

/**
 * AtomicFlowReceipt, "what actually happened" card.
 *
 * The payment is a single sponsored PTB carrying the transfer, the Spend + Save
 * NAVI supply (when round-up is on) and an on-chain receipt in ONE signature,
 * no wallet prompt, no gas. So "1 atomic transaction" in the header is literal:
 * every row below shares one digest.
 *
 * Every row is derived ONLY from real data passed in by the caller, and the
 * Save row is driven by the SERVER-VERIFIED outcome, never by the amount we
 * hoped to save:
 *
 *   saved    green check, the supply is on chain and the tally moved.
 *   pending  spinner, the send landed and the save is inside it but the server
 *            hasn't been able to read it back yet, so nothing is credited.
 *   failed   alert, and we say plainly that the savings total didn't move.
 *   none     no row at all.
 *
 * It must never claim money that didn't move. Before this, `hasSave` was driven
 * purely by whether an amount was passed in, and the row always rendered a
 * green "Rounded up $X" — including for sends where no save happened.
 */

import { motion, useReducedMotion, type Transition } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  ArrowUpRight01Icon,
  Loading03Icon,
  AlertCircleIcon,
} from "@hugeicons/core-free-icons";

const EXPLORER = "https://suiscan.xyz/mainnet/tx/";

export type AtomicFlowReceiptProps = {
  /** Already-formatted paid amount incl. currency symbol, e.g. "$12.50". */
  amountText: string;
  /** Recipient display name / handle the payment went to. */
  recipientDisplay: string;
  /** Already-formatted round-up amount incl. symbol (e.g. "$0.50"); omit/empty when no Save leg ran. */
  savedText?: string;
  /**
   * Server-verified outcome of the Spend + Save leg. Defaults to "none" so a
   * caller that hasn't been updated cannot accidentally render a save claim.
   */
  saveStatus?: "none" | "saved" | "pending" | "failed";
  /** Why the save failed, when the server told us. */
  saveReason?: string;
  /** On-chain transaction digest, links to the explorer. */
  digest: string;
};

/** Per-row visual state. `done` is the soft-mint check every landed leg gets. */
type RowState = "done" | "pending" | "failed";

const ROW_STYLE: Record<
  RowState,
  { disc: string; icon: typeof CheckmarkCircle02Icon; color: string; spin: boolean }
> = {
  done: { disc: "bg-[#CAFFB8]", icon: CheckmarkCircle02Icon, color: "#3d7a29", spin: false },
  pending: { disc: "bg-[#15300c]/8", icon: Loading03Icon, color: "#5c7150", spin: true },
  failed: { disc: "bg-[#A05A3E]/15", icon: AlertCircleIcon, color: "#A05A3E", spin: false },
};

/** A single status disc + one line of plain copy. */
function StepRow({
  text,
  emphasis,
  index,
  reduce,
  state = "done",
}: {
  text: React.ReactNode;
  emphasis?: React.ReactNode;
  index: number;
  reduce: boolean | null;
  state?: RowState;
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
      <span
        className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-full ${ROW_STYLE[state].disc}`}
      >
        <motion.span
          className="flex items-center justify-center"
          animate={ROW_STYLE[state].spin && !reduce ? { rotate: 360 } : undefined}
          transition={
            ROW_STYLE[state].spin && !reduce
              ? { duration: 1.1, repeat: Infinity, ease: "linear" }
              : undefined
          }
        >
          <HugeiconsIcon
            icon={ROW_STYLE[state].icon}
            size={13}
            color={ROW_STYLE[state].color}
            strokeWidth={2.2}
          />
        </motion.span>
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
  saveStatus = "none",
  saveReason,
  digest,
}: AtomicFlowReceiptProps) {
  const reduce = useReducedMotion();
  const explorerUrl = `${EXPLORER}${digest}`;

  // Build the step list from real data only. The Save row is driven by
  // `saveStatus`, NOT by whether an amount happens to be present; the paid +
  // receipt rows always ran. `index` keeps the stagger sequential.
  const steps: {
    text: React.ReactNode;
    emphasis?: React.ReactNode;
    state?: RowState;
  }[] = [
    {
      text: (
        <>
          Paid <span className="font-mono">{amountText}</span> to{" "}
          <span className="text-[#15300c]">{recipientDisplay}</span>
        </>
      ),
    },
  ];
  if (saveStatus === "saved") {
    steps.push({
      text: (
        <>
          Rounded up <span className="font-mono">{savedText}</span> → earning in NAVI
        </>
      ),
    });
  } else if (saveStatus === "pending") {
    steps.push({
      state: "pending",
      text: (
        <>
          Round-up of <span className="font-mono">{savedText}</span> is confirming
        </>
      ),
    });
  } else if (saveStatus === "failed") {
    steps.push({
      state: "failed",
      text: (
        <>
          Round-up didn&apos;t go through, your savings total is unchanged
          {saveReason ? (
            <span className="block text-[11px] leading-4 text-[#5c7150]">{saveReason}</span>
          ) : null}
        </>
      ),
    });
  }
  steps.push({ text: <>Receipt recorded on-chain</> });

  return (
    <div className="w-full rounded-[28px] border border-[#15300c]/15 bg-white/60 px-5 py-4 text-left backdrop-blur-sm">
      {/* Header: the POINT, every leg above landed in a single signature. */}
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
          <StepRow
            key={i}
            text={s.text}
            emphasis={s.emphasis}
            index={i}
            reduce={reduce}
            state={s.state}
          />
        ))}
      </ul>
    </div>
  );
}

export default AtomicFlowReceipt;
