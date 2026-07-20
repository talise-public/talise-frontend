/**
 * Payment Intents, Sui's canonical pattern for bundling many heterogeneous
 * payment operations into one atomic, single-signed PTB. Resolve → Plan →
 * Execute.
 *
 *   • Resolve: read balances, swap quotes, addresses in parallel
 *   • Plan:    sequence operations so later legs consume earlier outputs
 *   • Execute: one signature, one gas payment, atomic or revert
 *
 * Each PTB builder in `lib/zkclient.ts` is wrapped here with a human
 * description (legs) so the UI can show the user EXACTLY what they're
 * signing, the bytes are the source of truth, and the legs make those
 * bytes legible.
 *
 * Reference: https://docs.sui.io/onchain-finance/payment-intents
 */

import type { Transaction } from "@mysten/sui/transactions";
import {
  buildSuiTransfer,
  buildUsdsuiTransfer,
  buildCrossAssetSend,
  buildPayAndInvest,
  buildBatchUsdsuiPayroll,
  buildSpotLPDeposit,
  readEphemeralForT2000,
  writeCachedProof,
  type SignAndSubmitResult,
  type StoredZkProof,
} from "./zkclient";
// Platform-wide Payment Kit receipts attach a defined transaction kind
// (visible to suivision/suiscan) to every Talise send. Gated behind
// NEXT_PUBLIC_PK_RECEIPTS_ENABLED, flip the flag on after running
// `pnpm pk:bootstrap` to mint the registry on chain.
import {
  buildUsdsuiTransferWithReceipt,
  buildUsdsuiBatchWithReceipts,
  paymentKitReceiptsEnabled,
  nonceFor,
} from "./payment-kit";
import { formatLocal, type Currency } from "./fx";
import { shortAddress } from "./format";

/**
 * Public asset alias used across intents and forms. USDsui is the canonical
 * dollar asset; SUI is the native gas/utility asset.
 */
export type Asset = "USDsui" | "SUI";

/**
 * Signer surface required by intents that execute via the @t2000/sdk
 * agentic layer. Mirrors `@t2000/sdk`'s `TransactionSigner` (we duplicate
 * the shape locally so this module, imported by client components -
 * doesn't pull the server-only SDK into the browser bundle).
 */
export type IntentSigner = {
  getAddress(): string;
  signTransaction(txBytes: Uint8Array): Promise<{ signature: string }>;
};

/** A single human-readable operation inside an intent. */
export type IntentLeg = {
  /** Maps to the dominant Move call type for an icon hint. */
  kind: "transfer" | "swap" | "split" | "deposit" | "mint" | "share" | "settle";
  /** Short imperative, "Pay £100 to Mama Adaeze". */
  title: string;
  /** Optional detail, "via Yellow Card · Lagos · seconds". */
  detail?: string;
};

/**
 * A typed bundle: builder + legs + summary. The legs are what the UI shows.
 *
 * Intents come in two flavours:
 *
 *  - **PTB-builder** intents (`build`), we own the PTB construction and
 *    sign locally via `signAndSubmit(intent.build)`. Used for transfers,
 *    payroll, bills, and other hand-rolled flows.
 *
 *  - **Agent-execute** intents (`execute`), we delegate to `@t2000/sdk`
 *    which routes through NAVI (save/borrow) and the Cetus aggregator
 *    (swap), executing the transaction itself with the caller's signer.
 *    `SendForm` and friends prefer `execute` when present.
 *
 * Exactly one of `build` or `execute` must be set per intent.
 */
export type PaymentIntent = {
  id: string;
  /** Section header in the preview, e.g. "Send money home". */
  title: string;
  /** One-line description of the net effect. */
  summary: string;
  /** Atomic operations, in execution order. */
  legs: IntentLeg[];
  /** The PTB builder, what gets signed. Mutually exclusive with `execute`. */
  build?: (tx: Transaction) => void | Promise<void>;
  /**
   * Agent-execute path: delegate the whole flow (build + sign + submit) to
   * the T2000 agent. Returns the same shape as `signAndSubmit` so the UI
   * can stay agnostic.
   */
  execute?: (signer: IntentSigner) => Promise<SignAndSubmitResult>;
};

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

function shortRecipient(addr: string): string {
  return shortAddress(addr, 6, 4);
}

/**
 * Browser-side helper: POST a T2000 op to our server route, attaching the
 * ephemeral key snapshot the route needs to rebuild the zkLogin signer.
 */
async function callT2000(payload: Record<string, unknown>): Promise<SignAndSubmitResult> {
  const eph = readEphemeralForT2000();
  if (!eph) {
    throw new Error("No active sign-in. Please sign in again.");
  }
  // `readEphemeralForT2000` already includes `cachedProof` when available.
  // If the server returns `freshProof` on cache miss, persist it so the
  // next call skips Shinami entirely.
  const res = await fetch("/api/t2000/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, ...eph }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "t2000 failed" }));
    throw new Error(err.error || `t2000 failed (HTTP ${res.status})`);
  }
  const { digest, freshProof } = (await res.json()) as {
    digest: string;
    freshProof?: StoredZkProof;
  };
  if (freshProof) writeCachedProof(freshProof);
  return { digest, created: {} };
}

// ---------------------------------------------------------------------------
// Intent: same-asset transfer
// ---------------------------------------------------------------------------

export function transferIntent(opts: {
  asset: Asset;
  amount: number;
  recipient: string;
  senderAddress: string;
}): PaymentIntent {
  const isUsdsui = opts.asset === "USDsui";
  const id = isUsdsui ? "transfer.usdsui" : "transfer.sui";
  return {
    id,
    title: "Send",
    summary: `Send ${isUsdsui ? "$" : ""}${opts.amount}${
      isUsdsui ? "" : " SUI"
    } to ${shortRecipient(opts.recipient)}.`,
    legs: [
      {
        kind: "transfer",
        title: `Pay ${shortRecipient(opts.recipient)}`,
        detail: `${isUsdsui ? "$" : ""}${opts.amount}${isUsdsui ? "" : " SUI"}`,
      },
    ],
    build: isUsdsui
      ? paymentKitReceiptsEnabled()
        ? buildUsdsuiTransferWithReceipt({
            sender: opts.senderAddress,
            receiver: opts.recipient,
            amountUsdsui: opts.amount,
            nonce: nonceFor("transfer", opts.senderAddress, opts.recipient),
          }).build
        : buildUsdsuiTransfer({
            senderAddress: opts.senderAddress,
            amountMicro: BigInt(Math.round(opts.amount * 1e6)),
            recipient: opts.recipient,
          })
      : buildSuiTransfer({
          amountMist: BigInt(Math.round(opts.amount * 1e9)),
          recipient: opts.recipient,
        }),
  };
}

// ---------------------------------------------------------------------------
// Intent: cross-asset send (SUI ↔ USDsui via Cetus aggregator)
//
// Backed by `@t2000/sdk`'s `swap()` which routes across 20+ Sui DEXs via
// the Cetus aggregator for best execution. The agent owns the build + sign
// + submit lifecycle, so we expose this intent via the `execute` path
// instead of the local PTB-builder path. `recipient` defaults back to the
// sender's wallet, the aggregator settles the output coin to the caller.
// ---------------------------------------------------------------------------

export function crossAssetIntent(opts: {
  senderAddress: string;
  payAsset: Asset;
  receiveAsset: Asset;
  payAmount: number;
  recipient: string;
}): PaymentIntent {
  return {
    id: "transfer.crossasset",
    title: "Send across assets",
    summary: `Convert ${opts.payAsset} → ${opts.receiveAsset} and pay ${shortRecipient(
      opts.recipient
    )} in one signature.`,
    legs: [
      { kind: "split", title: `Pull ${opts.payAmount} ${opts.payAsset} from your balance` },
      {
        kind: "swap",
        title: "Swap via Cetus aggregator (20+ DEXs)",
        detail: `${opts.payAsset} → ${opts.receiveAsset}`,
      },
      {
        kind: "transfer",
        title: `Pay ${shortRecipient(opts.recipient)} in ${opts.receiveAsset}`,
      },
      { kind: "settle", title: "Return any leftover to you" },
    ],
    execute: async () =>
      callT2000({
        op: "swap",
        from: opts.payAsset,
        to: opts.receiveAsset,
        amount: opts.payAmount,
      }),
  };
}

// ---------------------------------------------------------------------------
// Intent: pay + invest (the brief's example #1)
// ---------------------------------------------------------------------------

export function payAndInvestIntent(opts: {
  senderAddress: string;
  payAmount: number;
  investAmount: number;
  recipient: string;
}): PaymentIntent {
  return {
    id: "transfer.pay-and-invest",
    title: "Pay and invest",
    summary: `Send $${opts.payAmount} to ${shortRecipient(
      opts.recipient
    )} and deploy $${opts.investAmount} into a yield vault, one signature.`,
    legs: [
      { kind: "split", title: `Pull $${opts.payAmount + opts.investAmount} from your balance` },
      { kind: "transfer", title: `Pay ${shortRecipient(opts.recipient)} $${opts.payAmount}` },
      { kind: "mint", title: "Open a fresh yield vault you own" },
      { kind: "deposit", title: `Deposit $${opts.investAmount} into the vault` },
      { kind: "share", title: "Make the vault tradable so it can start earning" },
    ],
    build: buildPayAndInvest({
      senderAddress: opts.senderAddress,
      payAmountMicro: BigInt(Math.round(opts.payAmount * 1e6)),
      investAmountMicro: BigInt(Math.round(opts.investAmount * 1e6)),
      recipient: opts.recipient,
    }),
  };
}

// ---------------------------------------------------------------------------
// Intent: remittance, the headline intent for Talise's repositioning.
//
// Bundles: pull USDsui + take platform fee + transfer to settlement address
// (off-ramp partner or recipient). Recipient sees their local currency in
// the UI even though the bytes settle USDsui on-chain.
// ---------------------------------------------------------------------------

export function remittanceIntent(opts: {
  senderAddress: string;
  /** Gross amount the sender is sending, in USDsui dollars (e.g. 100). */
  amountUsdsui: number;
  /** Recipient's local currency for display only, settlement is USDsui. */
  recipientCurrency: Currency;
  /** Off-ramp partner or recipient Sui address that takes settlement USDsui. */
  settlementAddress: string;
  /** Where the platform's slice settles. */
  feeCollector: string;
  /** Fee in basis points (e.g. 100 = 1%). */
  feeBps: number;
  /** Human label for the recipient, e.g. "Mama Adaeze · +234 80x xxx xxx". */
  recipientLabel: string;
}): PaymentIntent {
  const feeUsdsui = (opts.amountUsdsui * opts.feeBps) / 10_000;
  const settleUsdsui = opts.amountUsdsui - feeUsdsui;
  const localOut = formatLocal(settleUsdsui, opts.recipientCurrency);

  return {
    id: "remittance",
    title: "Send money home",
    summary: `$${opts.amountUsdsui.toFixed(
      2
    )} out → ${opts.recipientLabel} receives ${localOut}.`,
    legs: [
      {
        kind: "split",
        title: `Pull $${opts.amountUsdsui.toFixed(2)} from your balance`,
      },
      ...(feeUsdsui > 0
        ? [
            {
              kind: "transfer" as const,
              title: `Platform fee (${(opts.feeBps / 100).toFixed(2)}%)`,
              detail: `$${feeUsdsui.toFixed(2)}`,
            },
          ]
        : []),
      {
        kind: "settle",
        title: `Settle to ${opts.recipientLabel}`,
        detail: `${localOut} · ~2 sec`,
      },
    ],
    build: paymentKitReceiptsEnabled()
      ? buildUsdsuiBatchWithReceipts({
          sender: opts.senderAddress,
          kind: "remittance",
          recipients: [
            ...(feeUsdsui > 0
              ? [
                  {
                    address: opts.feeCollector,
                    amountUsdsui: feeUsdsui,
                    label: "fee",
                  },
                ]
              : []),
            {
              address: opts.settlementAddress,
              amountUsdsui: settleUsdsui,
              label: "settle",
            },
          ],
        }).build
      : buildBatchUsdsuiPayroll({
          senderAddress: opts.senderAddress,
          recipients: [
            ...(feeUsdsui > 0
              ? [
                  {
                    address: opts.feeCollector,
                    amountMicro: BigInt(Math.round(feeUsdsui * 1e6)),
                    ref: "fee",
                  },
                ]
              : []),
            {
              address: opts.settlementAddress,
              amountMicro: BigInt(Math.round(settleUsdsui * 1e6)),
              ref: "settle",
            },
          ],
        }),
  };
}

// ---------------------------------------------------------------------------
// Intent: batch payroll
// ---------------------------------------------------------------------------

export function payrollIntent(opts: {
  senderAddress: string;
  recipients: { address: string; amountMicro: bigint; label?: string }[];
}): PaymentIntent {
  const total = opts.recipients.reduce((s, r) => s + r.amountMicro, 0n);
  const totalUsdsui = Number(total) / 1e6;
  return {
    id: "payroll",
    title: "Pay everyone",
    summary: `$${totalUsdsui.toFixed(2)} out → ${
      opts.recipients.length
    } recipient${opts.recipients.length === 1 ? "" : "s"}, atomic.`,
    legs: opts.recipients.map((r) => ({
      kind: "transfer" as const,
      title: r.label ?? `Pay ${shortRecipient(r.address)}`,
      detail: `$${(Number(r.amountMicro) / 1e6).toFixed(2)}`,
    })),
    build: paymentKitReceiptsEnabled()
      ? buildUsdsuiBatchWithReceipts({
          sender: opts.senderAddress,
          kind: "payroll",
          recipients: opts.recipients.map((r) => ({
            address: r.address,
            amountUsdsui: Number(r.amountMicro) / 1e6,
            label: r.label,
          })),
        }).build
      : buildBatchUsdsuiPayroll(opts),
  };
}

// ---------------------------------------------------------------------------
// Intent: save into NAVI lending (deploy idle savings)
//
// Backed by `@t2000/sdk`'s `save()` which routes USDC into NAVI's lending
// markets at the best-available APY (currently ~3–8% on testnet/mainnet).
// Supersedes the previous DeepBook BalanceManager-mint flow, NAVI is a
// pooled lending market, not a per-user vault, so there's no object to
// create + share.
// ---------------------------------------------------------------------------

export function spotLpIntent(opts: {
  senderAddress: string;
  amountUsdsui: number;
}): PaymentIntent {
  return {
    id: "earn.spot-lp",
    title: "Earn yield",
    summary: `Supply $${opts.amountUsdsui} USDsui to NAVI lending and start earning APY.`,
    legs: [
      {
        kind: "deposit",
        title: `Supply $${opts.amountUsdsui} USDsui to NAVI lending`,
        detail: "best available lending APY",
      },
      { kind: "settle", title: "NAVI supply position credited to your wallet" },
    ],
    execute: async () =>
      callT2000({ op: "save", amount: opts.amountUsdsui, asset: "USDsui" }),
  };
}

// ---------------------------------------------------------------------------
// Intent: margin supply (alias of save, NAVI unifies all USDsui supply)
//
// T2000 unifies "earn yield" and "supply liquidity for borrowing" under a
// single NAVI `save()` primitive, the supply position itself is the
// borrowing collateral. We keep the separate intent ID so existing UI
// surfaces stay routable, but the underlying call is identical.
// ---------------------------------------------------------------------------

export function marginSupplyIntent(opts: {
  senderAddress: string;
  amountUsdsui: number;
}): PaymentIntent {
  return {
    id: "earn.margin-supply",
    title: "Supply liquidity",
    summary: `Supply $${opts.amountUsdsui} USDsui to NAVI, earns APY and unlocks borrowing power.`,
    legs: [
      {
        kind: "deposit",
        title: `Supply $${opts.amountUsdsui} USDsui to NAVI lending`,
        detail: "earns APY · doubles as borrow collateral",
      },
      { kind: "settle", title: "Supply position credited to your wallet" },
    ],
    execute: async () =>
      callT2000({ op: "save", amount: opts.amountUsdsui, asset: "USDsui" }),
  };
}

// ---------------------------------------------------------------------------
// Intent: deposit autosplit
//
// Per the docs: "When a deposit arrives, keep 1,000 USDC liquid, deposit 60%
// of the rest into a yield pool, and convert the remainder to SUI."
//
// This is the brief's #2 example ("salary that streams and earns yield") as
// a one-shot intent. The recurring trigger (run on every inbound) is a Move
// rule-registry layer we'll add later, this is the underlying atomic.
// ---------------------------------------------------------------------------

export function depositAutosplitIntent(opts: {
  senderAddress: string;
  /** Gross dollars to allocate. */
  incomingUsdc: number;
  /** Dollars to leave liquid in the wallet (no Move calls; just untouched). */
  reserveUsdc: number;
  /** Of the post-reserve remainder, what % goes into the yield vault. */
  yieldPct: number; // 0–100
}): PaymentIntent {
  const reserve = Math.min(opts.reserveUsdc, opts.incomingUsdc);
  const remainder = Math.max(0, opts.incomingUsdc - reserve);
  const yieldUsdc = (remainder * opts.yieldPct) / 100;
  const swapUsdc = remainder - yieldUsdc;

  const legs: IntentLeg[] = [
    {
      kind: "split",
      title: `Reserve $${reserve.toFixed(2)} liquid`,
      detail: "stays in your wallet",
    },
  ];
  if (yieldUsdc > 0) {
    legs.push(
      { kind: "mint", title: "Open a fresh yield vault you own" },
      {
        kind: "deposit",
        title: `Deposit $${yieldUsdc.toFixed(2)} into the vault`,
      },
      { kind: "share", title: "Make the vault tradable so it can start earning" }
    );
  }
  if (swapUsdc > 0) {
    legs.push({
      kind: "swap",
      title: `Convert $${swapUsdc.toFixed(2)} to SUI`,
      detail: "DeepBook Spot",
    });
  }

  // The build composes two existing builders in one Transaction. yieldUsdc
  // takes the same PTB as spotLpIntent; swapUsdc takes the same PTB as
  // crossAssetIntent. Both wrapped here so a single sponsor signature covers
  // the whole rule.
  return {
    id: "deposit-autosplit",
    title: "Deposit autosplit",
    summary: `Split $${opts.incomingUsdc.toFixed(2)}: $${reserve.toFixed(
      2
    )} liquid · $${yieldUsdc.toFixed(2)} yield · $${swapUsdc.toFixed(2)} SUI.`,
    legs,
    build: async (tx) => {
      if (yieldUsdc > 0) {
        await buildSpotLPDeposit({
          senderAddress: opts.senderAddress,
          amountMicro: BigInt(Math.round(yieldUsdc * 1e6)),
        })(tx);
      }
      if (swapUsdc > 0) {
        await buildCrossAssetSend({
          senderAddress: opts.senderAddress,
          payAsset: "USDC",
          receiveAsset: "SUI",
          payAmount: BigInt(Math.round(swapUsdc * 1e6)),
          recipient: opts.senderAddress, // SUI lands back in the same wallet
        })(tx);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Intent: bill batch
//
// Per the docs: "Pay rent, utilities, and my phone bill on the first of the
// month. Three transfers to three resolved contacts, batched atomically."
//
// For the African-corridor product this is rent + DSTV + NEPA token + GLO
// airtime in one signature. If any leg is invalid the whole batch reverts
//, the user can fix the bad bill and retry without partial state.
// ---------------------------------------------------------------------------

export function billBatchIntent(opts: {
  senderAddress: string;
  bills: {
    /** "Rent" / "DSTV" / "NEPA" / "Glo airtime" */
    name: string;
    /** Resolved Sui address of the biller or off-ramp partner. */
    address: string;
    /** Amount in dollars (USDsui). */
    amountUsdsui: number;
  }[];
}): PaymentIntent {
  const total = opts.bills.reduce((s, b) => s + b.amountUsdsui, 0);
  return {
    id: "bills.batch",
    title: "Pay all bills",
    summary: `$${total.toFixed(2)} out → ${opts.bills.length} bill${
      opts.bills.length === 1 ? "" : "s"
    }, atomic.`,
    legs: opts.bills.map((b) => ({
      kind: "transfer" as const,
      title: b.name,
      detail: `$${b.amountUsdsui.toFixed(2)}`,
    })),
    build: paymentKitReceiptsEnabled()
      ? buildUsdsuiBatchWithReceipts({
          sender: opts.senderAddress,
          kind: "bills",
          recipients: opts.bills.map((b) => ({
            address: b.address,
            amountUsdsui: b.amountUsdsui,
            label: b.name,
          })),
        }).build
      : buildBatchUsdsuiPayroll({
          senderAddress: opts.senderAddress,
          recipients: opts.bills.map((b) => ({
            address: b.address,
            amountMicro: BigInt(Math.round(b.amountUsdsui * 1e6)),
            ref: b.name,
          })),
        }),
  };
}

// ---------------------------------------------------------------------------
// Intent: rebalance
//
// Per the docs: "Sell enough SUI to bring my portfolio back to 70% USDC, 30%
// SUI. The payment intent reads current balances and prices, computes the
// delta, and executes a single swap. The read and the swap are part of the
// same atomic unit, so the price you swap at is the price you read."
//
// The caller passes pre-resolved current balances + price (the "Resolve"
// phase). We compute the swap amount client-side and emit it as a single
// DeepBook swap leg. A future on-chain version reads balances at execution
// time, that needs a Move helper.
// ---------------------------------------------------------------------------

export function rebalanceIntent(opts: {
  senderAddress: string;
  usdcBalance: number; // dollars
  suiBalance: number; // SUI units
  suiPrice: number; // USD per SUI
  /** Target USDC weight in [0,1]. e.g. 0.7 for 70/30. */
  targetUsdcWeight: number;
}): PaymentIntent {
  const suiValueUsd = opts.suiBalance * opts.suiPrice;
  const totalUsd = opts.usdcBalance + suiValueUsd;
  const targetUsdc = totalUsd * opts.targetUsdcWeight;
  const usdcGap = targetUsdc - opts.usdcBalance;
  // Positive gap → need to sell SUI; negative → need to buy SUI.
  const sellingSui = usdcGap > 0;
  const swapUsd = Math.abs(usdcGap);
  const swapSui = swapUsd / opts.suiPrice;

  return {
    id: "rebalance",
    title: "Rebalance",
    summary: sellingSui
      ? `Sell ${swapSui.toFixed(4)} SUI → ~$${swapUsd.toFixed(2)} USDC to hit ${(
          opts.targetUsdcWeight * 100
        ).toFixed(0)}% USDC.`
      : `Buy ~${swapSui.toFixed(4)} SUI with $${swapUsd.toFixed(2)} USDC to hit ${(
          opts.targetUsdcWeight * 100
        ).toFixed(0)}% USDC.`,
    legs: [
      {
        kind: "split",
        title: sellingSui
          ? `Pull ${swapSui.toFixed(4)} SUI from your balance`
          : `Pull $${swapUsd.toFixed(2)} from your balance`,
      },
      {
        kind: "swap",
        title: sellingSui ? "Swap SUI → USDC on DeepBook" : "Swap USDC → SUI on DeepBook",
        detail: `~$${swapUsd.toFixed(2)}`,
      },
      { kind: "settle", title: "Return swapped output to you" },
    ],
    build: buildCrossAssetSend({
      senderAddress: opts.senderAddress,
      payAsset: sellingSui ? "SUI" : "USDC",
      receiveAsset: sellingSui ? "USDC" : "SUI",
      payAmount: sellingSui
        ? BigInt(Math.round(swapSui * 1e9))
        : BigInt(Math.round(swapUsd * 1e6)),
      // Output lands back in the same wallet
      recipient: opts.senderAddress,
    }),
  };
}

// ---------------------------------------------------------------------------
// Intent: conditional send
//
// Per the docs: "If my USDC balance is above 5,000, send 500 to savings."
//
// V1 is client-side: we resolve the current balance and refuse to compile
// the intent if the condition fails. V2 will be an on-chain conditional
// (Move helper that asserts the balance at execution time, so the decision
// uses fresh state).
// ---------------------------------------------------------------------------

export function conditionalSendIntent(opts: {
  senderAddress: string;
  /** Current USDsui balance, resolved by caller. */
  currentUsdsui: number;
  /** Fire the transfer only if currentUsdsui >= threshold. */
  thresholdUsdsui: number;
  /** Amount to transfer when the condition is met. */
  amountUsdsui: number;
  /** Where the swept amount lands (e.g. your savings address). */
  recipient: string;
  /** Friendly label for the destination, "Savings". */
  destinationLabel?: string;
}): PaymentIntent | null {
  // Client-side gate, return null when the condition fails. The UI can
  // surface "condition not met yet" instead of a broken intent.
  if (opts.currentUsdsui < opts.thresholdUsdsui) return null;

  const label = opts.destinationLabel ?? shortRecipient(opts.recipient);
  return {
    id: "conditional-send",
    title: "Conditional send",
    summary: `Balance $${opts.currentUsdsui.toFixed(
      2
    )} ≥ $${opts.thresholdUsdsui.toFixed(2)}, sweep $${opts.amountUsdsui.toFixed(
      2
    )} to ${label}.`,
    legs: [
      {
        kind: "split",
        title: `Confirm balance ≥ $${opts.thresholdUsdsui.toFixed(2)}`,
        detail: "client-resolved",
      },
      {
        kind: "transfer",
        title: `Sweep $${opts.amountUsdsui.toFixed(2)} to ${label}`,
      },
    ],
    build: paymentKitReceiptsEnabled()
      ? buildUsdsuiTransferWithReceipt({
          sender: opts.senderAddress,
          receiver: opts.recipient,
          amountUsdsui: opts.amountUsdsui,
          nonce: nonceFor("sweep", opts.senderAddress, opts.recipient),
        }).build
      : buildUsdsuiTransfer({
          senderAddress: opts.senderAddress,
          amountMicro: BigInt(Math.round(opts.amountUsdsui * 1e6)),
          recipient: opts.recipient,
        }),
  };
}
