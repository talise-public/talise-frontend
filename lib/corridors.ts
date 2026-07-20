/**
 * Talise corridor registry, the single source of truth for which
 * money-movement corridors exist, what fiat rails sit at each end, and
 * how far along each one is (live / partner / planned).
 *
 * This is the merge of the two halves of the product directive:
 *   • African corridors, NG/NGN (live via Linq), KE/KES, GH/GHS, ZA/ZAR.
 *   • Asian / global    , JP/JPY, SG/SGD, PH/PHP, ID/IDR, VN/VND, US/USD.
 *
 * The model is deliberately descriptive metadata only, no I/O, no
 * provider clients. It is the registry that the FX edge, the (future)
 * corridor-agnostic transfers state machine, and the client UI all read
 * to decide what is offerable and at what spread. Provider wiring (Linq,
 * JPYC, PayNow, ACH/FedNow…) lives behind the per-corridor rails named
 * here but is NOT implemented in this file.
 *
 * Status semantics (per docs/strategy/cross-border-masterplan.md §2/§5):
 *   • "live"  , at least one direction is in production today.
 *   • "partner", the rail is being onboarded behind a licensed partner;
 *                 not yet generally available but actively in flight.
 *   • "planned", on the roadmap; no rail integration started.
 *
 * The chain stays invisible: every corridor settles USDsui/USDC at par on
 * Sui in the middle. `fiatInRail` / `fiatOutRail` describe only the fiat
 * legs the user actually touches.
 */

import type { Currency } from "@/lib/fx";
import { getQuote, corridorSpreadBps, type QuoteResult } from "@/lib/fx-feed";
import { canUseCorridor, type KycTier } from "@/lib/kyc";

/**
 * ISO 3166-1 alpha-2 country codes for the countries Talise has corridors
 * into or out of. Kept narrow so callers get autocompletion and tsc
 * catches typos at the corridor table.
 */
export type CountryCode =
  | "NG"
  | "KE"
  | "GH"
  | "ZA"
  | "JP"
  | "SG"
  | "PH"
  | "ID"
  | "VN"
  | "US";

/**
 * Settlement currencies. This is intentionally broader than `fx.ts`'s
 * `Currency` (which only covers the African display set today) because the
 * corridor registry must name JPY/SGD/PHP/IDR/VND/USD even before the FX
 * layer migrates off its hardcoded snapshot. When `fx.ts` grows to include
 * the Asian set, the two should converge, see the `Currency` re-export note.
 */
export type CorridorCurrency =
  | Currency // NGN | KES | GHS | ZAR | USD
  | "JPY"
  | "SGD"
  | "PHP"
  | "IDR"
  | "VND";

/** Lifecycle stage of a corridor. */
export type CorridorStatus = "live" | "partner" | "planned";

/**
 * A single directed money-movement corridor.
 *
 * Corridors are directional: `from*` is where fiat is collected (the
 * sender's leg) and `to*` is where fiat is paid out (the recipient's leg).
 * The reverse direction, if it exists, is a separate entry.
 */
export interface Corridor {
  /** Stable id, `${fromCountry}-${toCountry}` (e.g. "US-JP"). */
  id: string;
  /** Country where fiat is collected (sender side). */
  fromCountry: CountryCode;
  /** Currency collected on the sender side. */
  fromCcy: CorridorCurrency;
  /** Country where fiat is paid out (recipient side). */
  toCountry: CountryCode;
  /** Currency paid out on the recipient side. */
  toCcy: CorridorCurrency;
  /** Fiat-in rail (collection). e.g. "ACH/FedNow", "PayNow". */
  fiatInRail: string;
  /** Fiat-out rail (payout). e.g. "Linq (NGN bank)", "Zengin", "PayNow". */
  fiatOutRail: string;
  /** Lifecycle stage. */
  status: CorridorStatus;
  /**
   * Talise's FX/handling spread for this corridor, in basis points. Per
   * the master plan, spread is set per-corridor by realized volatility;
   * these are launch defaults, not contractual rates.
   */
  spreadBps: number;
  /**
   * Number of minor-unit decimal places for `toCcy` (the payout currency).
   * 0 for zero-decimal currencies (JPY, IDR, VND, NGN/KES/GHS rendered as
   * whole units), 2 for USD/SGD/ZAR/PHP. Used by the transfers machine to
   * round payout amounts correctly per locale.
   */
  minorUnits: number;
  /**
   * Optional per-transaction cap in USD. Where a rail is legally capped
   * (e.g. Japan's JPYC FSA Type-II rail at ¥1M ≈ ~$6,400), the cap is
   * expressed here in USD so the transfers machine can gate uniformly.
   */
  perTxCapUsd?: number;
  /**
   * Free-text licensing / regulatory note for ops + compliance review.
   * Compliance is a P0 blocker that does not exist in code yet; this field
   * documents the gating constraint per corridor so it is never lost.
   */
  licenseNote: string;
}

/**
 * The registry. Directed corridors only, a reverse leg (e.g. JP→US) is a
 * separate entry and is added when that direction has a rail.
 *
 * Notes on status assignment (master plan §2 expansion order):
 *   • US→NG is "live": the Linq NGN bank-payout off-ramp is in production
 *     today and the US card on-ramp (Stripe) is live.
 *   • Singapore is the licensing anchor and first self-licensable market,
 *     so SG corridors are "partner" (PSP-fronted while the MPI pends).
 *   • US→JP under the JPYC ¥1M cap is the launch beachhead, "partner".
 *   • The remaining African corridors and SG→ASEAN payouts are "planned".
 */
export const CORRIDORS: readonly Corridor[] = [
  // ── African corridors ──────────────────────────────────────────────
  {
    id: "US-NG",
    fromCountry: "US",
    fromCcy: "USD",
    toCountry: "NG",
    toCcy: "NGN",
    fiatInRail: "ACH/FedNow (default), Stripe card (surcharged)",
    fiatOutRail: "Linq (NGN bank deposit)",
    status: "live",
    spreadBps: 25,
    minorUnits: 0,
    licenseNote:
      "US leg: agent of a licensed remitter (FinCEN MSB + state MTL pending). NG payout via Linq (licensed PSP); Talise is not the merchant-of-record.",
  },
  {
    id: "US-KE",
    fromCountry: "US",
    fromCcy: "USD",
    toCountry: "KE",
    toCcy: "KES",
    fiatInRail: "ACH/FedNow (default), Stripe card (surcharged)",
    fiatOutRail: "M-Pesa / Pesalink (partner PSP)",
    status: "planned",
    spreadBps: 40,
    minorUnits: 0,
    licenseNote:
      "KES payout requires a CBK-licensed PSP / mobile-money partner (M-Pesa). No integration started.",
  },
  {
    id: "US-GH",
    fromCountry: "US",
    fromCcy: "USD",
    toCountry: "GH",
    toCcy: "GHS",
    fiatInRail: "ACH/FedNow (default), Stripe card (surcharged)",
    fiatOutRail: "GhIPSS / mobile money (partner PSP)",
    status: "planned",
    spreadBps: 40,
    minorUnits: 2,
    licenseNote:
      "GHS payout requires a BoG-licensed PSP partner. No integration started.",
  },
  {
    id: "US-ZA",
    fromCountry: "US",
    fromCcy: "USD",
    toCountry: "ZA",
    toCcy: "ZAR",
    fiatInRail: "ACH/FedNow (default), Stripe card (surcharged)",
    fiatOutRail: "PayShap / EFT (partner PSP)",
    status: "planned",
    spreadBps: 35,
    minorUnits: 2,
    licenseNote:
      "ZAR payout requires a SARB-aligned PSP partner; SARB cross-border exchange-control reporting applies. No integration started.",
  },

  // ── Asian / global corridors ───────────────────────────────────────
  {
    id: "US-JP",
    fromCountry: "US",
    fromCcy: "USD",
    toCountry: "JP",
    toCcy: "JPY",
    fiatInRail: "ACH/FedNow (default), Stripe card (surcharged)",
    fiatOutRail: "Zengin furikomi (via JPYC rail under the cap)",
    // Launch beachhead per master plan §2.
    status: "partner",
    spreadBps: 45,
    minorUnits: 0,
    // ¥1,000,000 JPYC/FSA Type-II per-transfer cap ≈ ~$6,400 at ¥/$ ~156.
    perTxCapUsd: 6400,
    licenseNote:
      "JP leg via JPYC Inc. (FSA Type-II funds-transfer, ¥1M/transfer cap). >¥1M needs Type-1 FTSP + EPIBP via a local partner + JP subsidiary (18-36mo). Launch consumer/SMB under the cap only.",
  },
  {
    id: "JP-US",
    fromCountry: "JP",
    fromCcy: "JPY",
    toCountry: "US",
    toCcy: "USD",
    fiatInRail: "Zengin furikomi into named virtual accounts (JP partner bank)",
    fiatOutRail: "RTP/FedNow instant credit (default), ACH",
    // Reverse leg of the beachhead.
    status: "partner",
    spreadBps: 45,
    minorUnits: 2,
    perTxCapUsd: 6400,
    licenseNote:
      "JP collection via JPYC Type-II (¥1M cap). US payout as agent of a licensed remitter; GENIUS-compliant stablecoin settlement required before 2028.",
  },
  {
    id: "SG-PH",
    fromCountry: "SG",
    fromCcy: "SGD",
    toCountry: "PH",
    toCcy: "PHP",
    fiatInRail: "PayNow / FAST",
    fiatOutRail: "InstaPay / PESONet (partner payout network)",
    status: "partner",
    spreadBps: 40,
    minorUnits: 2,
    licenseNote:
      "SG leg under MAS PSA via a licensed PSP/MPI partner (Nium/StraitsX) while Talise's MPI pends. PH payout via partner network (BSP-regulated).",
  },
  {
    id: "SG-ID",
    fromCountry: "SG",
    fromCcy: "SGD",
    toCountry: "ID",
    toCcy: "IDR",
    fiatInRail: "PayNow / FAST",
    fiatOutRail: "BI-FAST (partner payout network)",
    status: "planned",
    spreadBps: 45,
    minorUnits: 0,
    licenseNote:
      "SG leg via MAS-licensed PSP partner. IDR payout via a Bank Indonesia-licensed partner. No integration started.",
  },
  {
    id: "SG-VN",
    fromCountry: "SG",
    fromCcy: "SGD",
    toCountry: "VN",
    toCcy: "VND",
    fiatInRail: "PayNow / FAST",
    fiatOutRail: "NAPAS 247 (partner payout network)",
    status: "planned",
    spreadBps: 45,
    minorUnits: 0,
    licenseNote:
      "SG leg via MAS-licensed PSP partner. VND payout via an SBV-licensed partner; inbound-remittance reporting applies. No integration started.",
  },
  {
    id: "US-US",
    fromCountry: "US",
    fromCcy: "USD",
    toCountry: "US",
    toCcy: "USD",
    fiatInRail: "ACH/FedNow, Stripe card (surcharged)",
    fiatOutRail: "RTP/FedNow instant credit, ACH",
    // Domestic USD rail powers @handle-to-@handle and ramp in/out today.
    status: "live",
    spreadBps: 0,
    minorUnits: 2,
    licenseNote:
      "Domestic USD. Funded/paid via FedNow/RTP/ACH (Bridge/Column/Cross River) + Circle Mint for USDC. Operates as agent of a licensed remitter; NY carved out at launch.",
  },
] as const;

/** Return all corridors in the registry (defensive copy). */
export function listCorridors(): Corridor[] {
  return CORRIDORS.slice();
}

/**
 * Look up a single directed corridor by its endpoints. Returns `undefined`
 * if no corridor is registered for that direction.
 */
export function getCorridor(
  from: CountryCode,
  to: CountryCode
): Corridor | undefined {
  return CORRIDORS.find((c) => c.fromCountry === from && c.toCountry === to);
}

/**
 * True iff a corridor exists for the given direction AND is in production
 * ("live"). Partner/planned corridors return false, use this as the hard
 * gate before offering a real money movement.
 */
export function isCorridorLive(from: CountryCode, to: CountryCode): boolean {
  return getCorridor(from, to)?.status === "live";
}

// ── Integration: registry × FX feed × KYC ──────────────────────────────
// These tie the three independently-built layers into the primitives the
// send/offramp paths actually call, so corridor policy, pricing, and
// access live behind one door.

/** True if a corridor is bookable now (live OR a partner rail is up). */
export function isCorridorBookable(c: Corridor): boolean {
  return c.status === "live" || c.status === "partner";
}

/**
 * Whether a corridor is permitted for a KYC tier. Cross-border corridors
 * (fromCountry !== toCountry) require the tier's "all" access; same-country
 * corridors are allowed at "domestic". Delegates the policy to kyc.ts's
 * `canUseCorridor` so access rules live in exactly one place.
 */
export function corridorAccessForTier(c: Corridor, tier: KycTier): boolean {
  return canUseCorridor(tier, c.fromCountry === c.toCountry);
}

export type CorridorQuoteResult =
  | { ok: true; corridor: Corridor; quote: Extract<QuoteResult, { ok: true }>["quote"] }
  | { ok: false; code: "UNKNOWN_CORRIDOR" | "NOT_BOOKABLE" | "OVER_CAP" | "FX"; message: string };

/**
 * The product primitive: price a corridor transfer end-to-end.
 *
 * Resolves the directed corridor, rejects planned/unbookable corridors and
 * over-cap amounts (perTxCapUsd, recall the JP ¥1M-equivalent partner-rail
 * cap), then defers pricing to the server-authoritative FX feed
 * (`getQuote`). The corridor's registry `spreadBps` is treated as a policy
 * FLOOR: the effective spread is the larger of the registry spread and the
 * feed's volatility-tier spread, so a corridor can charge more than the
 * risk floor but never less. The returned quote is the feed's locked quote;
 * `effectiveSpreadBps` documents the floor that was enforced.
 *
 * `amountUsd` is the USD value of the send (USDsui is 1:1 USD), used only
 * for the cap check; `amountFrom` is the sender-currency amount priced.
 */
export async function corridorQuote(
  from: CountryCode,
  to: CountryCode,
  amountFrom: number,
  amountUsd: number
): Promise<CorridorQuoteResult> {
  const corridor = getCorridor(from, to);
  if (!corridor) {
    return { ok: false, code: "UNKNOWN_CORRIDOR", message: "No corridor for that route." };
  }
  if (!isCorridorBookable(corridor)) {
    return { ok: false, code: "NOT_BOOKABLE", message: "This corridor isn't open yet." };
  }
  if (corridor.perTxCapUsd != null && amountUsd > corridor.perTxCapUsd) {
    return {
      ok: false,
      code: "OVER_CAP",
      message: `This corridor caps single transfers at $${corridor.perTxCapUsd.toLocaleString()}.`,
    };
  }

  const fx = await getQuote(corridor.fromCcy, corridor.toCcy, amountFrom);
  if (!fx.ok) {
    return { ok: false, code: "FX", message: fx.message };
  }
  // Enforce the registry spread as a floor (documented; the feed already
  // applied its vol-tier spread, we surface the floor that governs).
  const floorBps = Math.max(corridor.spreadBps, corridorSpreadBps(corridor.fromCcy, corridor.toCcy));
  return { ok: true, corridor: { ...corridor, spreadBps: floorBps }, quote: fx.quote };
}
