/**
 * Circle Mint interface — USD wire/ACH → USDC on Sui, 1:1, at par.
 *
 * Master plan §4/§6: Talise uses Circle Mint *directly* (USD wire → USDC on
 * Sui, 1:1, ~0bps) to capture mint/redeem at par rather than buying USDC
 * retail through MoonPay/Transak. This is what makes bank funding "free" and
 * therefore the default. Circle Mint also redeems USDC → USD on the off-ramp
 * leg ("US pool: USDC → USD via Circle Mint redemption" in the §3 flow).
 *
 * This module is a typed INTERFACE + a deterministic MOCK implementation.
 * When the real Circle Mint relationship is live, swap the mock for an HTTP
 * client behind the same `CircleMint` interface — callers don't change.
 *
 * Scope: this is additive plumbing. It does NOT touch the existing Stripe
 * onramp routes; it is the bank-funded settlement primitive those routes do
 * not have.
 */

import { randomUUID } from "node:crypto";

/** USDC and USDsui are both 6-decimal on Sui; par means amounts match 1:1. */
export const USDC_DECIMALS = 6;

/** Whether the funding USD arrives by wire or ACH (affects settlement time only). */
export type CircleFundingRail = "wire" | "ach";

export type MintStatus =
  | "pending" // wire/ACH initiated, USD not yet confirmed at Circle
  | "settling" // USD confirmed; USDC mint + on-chain delivery in flight
  | "complete" // USDC delivered to the destination Sui address
  | "failed";

/** A request to mint USDC on Sui against an inbound USD payment, at par. */
export type MintRequest = {
  /** USD the user wired/ACH'd in. USDC minted is exactly this (par, ~0bps). */
  readonly amountUsd: number;
  /** Sui address that receives the freshly minted USDC. */
  readonly destinationSuiAddress: string;
  /** Wire vs ACH — informational; mint is par either way. */
  readonly rail: CircleFundingRail;
  /** Idempotency key so a retried wire never double-mints. */
  readonly idempotencyKey?: string;
};

/** Result of a mint request. `usdcAmount === amountUsd` always (par). */
export type MintResult = {
  readonly id: string;
  readonly status: MintStatus;
  /** USDC minted, 1:1 with `amountUsd` (no spread, no fee). */
  readonly usdcAmount: number;
  /** Echoed back for the ledger. */
  readonly amountUsd: number;
  readonly destinationSuiAddress: string;
  readonly rail: CircleFundingRail;
  /** Sui tx digest once `status === "complete"` (mock returns a stub). */
  readonly suiTxDigest?: string;
  readonly createdAt: number;
};

/** A request to redeem USDC on Sui back to USD (off-ramp / float rebalance). */
export type RedeemRequest = {
  /** USDC to redeem. USD paid out is exactly this (par). */
  readonly usdcAmount: number;
  /** Bank account reference (opaque; resolved by the Circle Mint account). */
  readonly bankAccountRef: string;
  readonly idempotencyKey?: string;
};

export type RedeemResult = {
  readonly id: string;
  readonly status: MintStatus;
  /** USD paid out, 1:1 with `usdcAmount`. */
  readonly amountUsd: number;
  readonly usdcAmount: number;
  readonly createdAt: number;
};

/**
 * The Circle Mint port. The mock and the eventual HTTP client both satisfy
 * this, so callers (onramp routes, float rebalancer) depend only on the shape.
 */
export interface CircleMint {
  /** USD in → USDC on Sui, at par. */
  mint(req: MintRequest): Promise<MintResult>;
  /** USDC on Sui → USD out, at par. */
  redeem(req: RedeemRequest): Promise<RedeemResult>;
  /** Poll a mint by id. */
  getMint(id: string): Promise<MintResult | null>;
}

const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

function roundMicros(amount: number): number {
  // 6dp par rounding, matching USDC/USDsui on Sui.
  return Math.round(amount * 1_000_000) / 1_000_000;
}

/**
 * Deterministic in-memory mock. Mint completes synchronously at par with a
 * stub digest; this is enough to wire the bank-funding flow end-to-end before
 * the real Circle relationship exists. No network, no persistence.
 */
class MockCircleMint implements CircleMint {
  private readonly mints = new Map<string, MintResult>();

  async mint(req: MintRequest): Promise<MintResult> {
    if (!Number.isFinite(req.amountUsd) || req.amountUsd <= 0) {
      throw new Error("circle-mint: amountUsd must be a positive number");
    }
    if (!SUI_ADDRESS_RE.test(req.destinationSuiAddress)) {
      throw new Error("circle-mint: invalid destinationSuiAddress");
    }
    const amountUsd = roundMicros(req.amountUsd);
    const id = req.idempotencyKey ?? randomUUID();
    // Idempotent on the key: a retried wire returns the original mint.
    const existing = this.mints.get(id);
    if (existing) return existing;

    const result: MintResult = {
      id,
      status: "complete",
      usdcAmount: amountUsd, // par
      amountUsd,
      destinationSuiAddress: req.destinationSuiAddress,
      rail: req.rail,
      suiTxDigest: `mock-mint-${id}`,
      createdAt: Date.now(),
    };
    this.mints.set(id, result);
    return result;
  }

  async redeem(req: RedeemRequest): Promise<RedeemResult> {
    if (!Number.isFinite(req.usdcAmount) || req.usdcAmount <= 0) {
      throw new Error("circle-mint: usdcAmount must be a positive number");
    }
    const usdcAmount = roundMicros(req.usdcAmount);
    return {
      id: req.idempotencyKey ?? randomUUID(),
      status: "complete",
      amountUsd: usdcAmount, // par
      usdcAmount,
      createdAt: Date.now(),
    };
  }

  async getMint(id: string): Promise<MintResult | null> {
    return this.mints.get(id) ?? null;
  }
}

let singleton: CircleMint | null = null;

/**
 * Return the active Circle Mint client. Today this is always the mock; when
 * `CIRCLE_MINT_API_KEY` is wired to a real HTTP client, branch here so callers
 * stay unchanged.
 */
export function circleMint(): CircleMint {
  if (!singleton) {
    singleton = new MockCircleMint();
  }
  return singleton;
}

/** True once a real Circle Mint relationship is configured (env-gated). */
export function circleMintConfigured(): boolean {
  return Boolean(process.env.CIRCLE_MINT_API_KEY);
}
