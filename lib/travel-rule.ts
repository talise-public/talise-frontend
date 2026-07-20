/**
 * FATF Travel Rule scaffolding, IVMS-101 types + transfer routing.
 *
 * Master plan reference: docs/strategy/cross-border-masterplan.md §7
 * ("Compliance Operating Model" → "FATF Travel Rule"). Compliance is a P0
 * launch blocker that does not exist in the codebase yet; this module is the
 * first additive piece of that program.
 *
 * What the Travel Rule requires (FATF Recommendation 16): for transfers at or
 * above a threshold (~$1,000 in most jurisdictions; KR ~KRW 1M), the
 * originating VASP must transmit originator + beneficiary identity data -
 * formatted as IVMS-101, to the beneficiary VASP via a Travel Rule network
 * (Notabene, Sumsub, TRP, TRUST) BEFORE or alongside settlement.
 *
 * The wallet model splits cleanly into three routes (see `routeTransfer`):
 *
 *   • INTERNAL    , Talise ↔ Talise. Both legs are inside Talise's own
 *                     ledger, so no external IVMS-101 message is needed; the
 *                     originator/beneficiary data already lives with us. This
 *                     is the bulk of consumer flow.
 *   • EXTERNAL_VASP, Talise → another VASP (exchange, custodial wallet). Above
 *                     threshold this requires VASP discovery + an IVMS-101
 *                     exchange over a Travel Rule network, with a "sunrise"
 *                     fallback when the counterparty isn't reachable.
 *   • UNHOSTED    , Talise → self-custodial / unhosted wallet. No counterparty
 *                     VASP exists; obligation is typically beneficiary
 *                     self-declaration per local rules.
 *
 * SCOPE: this file is an additive library only, pure IVMS-101 types, the
 * threshold constant, the routing classifier, and a Notabene-shaped client
 * STUB. It is intentionally NOT wired into the send path. The documented
 * integration point lives at the bottom of this file
 * (`TRAVEL_RULE_INTEGRATION_POINT`).
 *
 * Persistence: above-threshold transfer metadata is captured in the
 * `travel_rule_records` table (see web/lib/db.ts ensureSchema). A typed
 * insert helper, `recordTravelRuleTransfer`, lives in this module and writes
 * through the shared `db()` adapter.
 */

import { db, ensureSchema } from "@/lib/db";

// ───────────────────────────────────────────────────────────────────
// IVMS-101, interVASP Messaging Standard
//
// IVMS-101 is the FATF-endorsed data model for originator/beneficiary
// information. The full standard is large; the subset below covers the
// natural-person + legal-person identity shapes Talise needs for consumer
// and SMB transfers. Field names follow the IVMS-101 spec so a downstream
// Travel Rule network adapter can map them 1:1.
// ───────────────────────────────────────────────────────────────────

/** IVMS-101 `NaturalPersonNameTypeCode` (subset used for individuals). */
export type IvmsNaturalPersonNameType =
  | "LEGL" // Legal name
  | "BIRT" // Name at birth
  | "MAID" // Maiden name
  | "ALIA" // Alias
  | "MISC"; // Unspecified

/** IVMS-101 `AddressTypeCode`. */
export type IvmsAddressType =
  | "HOME" // Residential
  | "BIZZ" // Business
  | "GEOG"; // Geographic

/** IVMS-101 `NationalIdentifierTypeCode` (subset). */
export type IvmsNationalIdentifierType =
  | "ARNU" // Alien registration number
  | "CCPT" // Passport number
  | "RAID" // Registration authority identifier
  | "DRLC" // Driver license number
  | "FIIN" // Foreign investment identity number
  | "TXID" // Tax identification number
  | "SOCS" // Social security number
  | "IDCD" // Identity card number
  | "LEIX" // Legal Entity Identifier (LEI)
  | "MISC"; // Unspecified

/** IVMS-101 structured name (a single name element). */
export interface IvmsNameIdentifier {
  /** Family / surname. */
  primaryIdentifier: string;
  /** Given name(s). */
  secondaryIdentifier?: string;
  nameIdentifierType: IvmsNaturalPersonNameType;
}

/** IVMS-101 geographic address. */
export interface IvmsGeographicAddress {
  addressType: IvmsAddressType;
  /** ISO 3166-1 alpha-2 country code, e.g. "US", "JP", "SG", "NG". */
  country: string;
  /** Town / city name. */
  townName?: string;
  /** Subdivision (state / prefecture). */
  countrySubDivision?: string;
  /** Free-form address lines when structured fields are unavailable. */
  addressLine?: string[];
  postCode?: string;
}

/** IVMS-101 national identification (passport, tax id, LEI, …). */
export interface IvmsNationalIdentification {
  nationalIdentifier: string;
  nationalIdentifierType: IvmsNationalIdentifierType;
  /** ISO 3166-1 alpha-2 country of the issuing authority. */
  countryOfIssue?: string;
  /** Registration authority (e.g. "RA000462" for the GLEIF LEI registry). */
  registrationAuthority?: string;
}

/** IVMS-101 natural person (an individual). */
export interface IvmsNaturalPerson {
  name: IvmsNameIdentifier[];
  geographicAddress?: IvmsGeographicAddress[];
  nationalIdentification?: IvmsNationalIdentification;
  /** ISO 3166-1 alpha-2 country of residence. */
  countryOfResidence?: string;
  /** Internal customer identifier within the originating/beneficiary VASP. */
  customerIdentification?: string;
}

/** IVMS-101 legal person (a business / entity). */
export interface IvmsLegalPerson {
  /** Registered legal name of the entity. */
  name: string;
  geographicAddress?: IvmsGeographicAddress[];
  nationalIdentification?: IvmsNationalIdentification;
  /** ISO 3166-1 alpha-2 country of registration. */
  countryOfRegistration?: string;
  customerIdentification?: string;
}

/**
 * IVMS-101 `Person`, exactly one of natural / legal is populated. The
 * discriminated union keeps tsc honest about which branch is present.
 */
export type IvmsPerson =
  | { naturalPerson: IvmsNaturalPerson; legalPerson?: never }
  | { legalPerson: IvmsLegalPerson; naturalPerson?: never };

/**
 * IVMS-101 originator, who is sending. Carries the person identity plus the
 * on-chain account(s) the value moves from.
 */
export interface IvmsOriginator {
  originatorPersons: IvmsPerson[];
  /** Sui address(es) the funds originate from. */
  accountNumber: string[];
}

/**
 * IVMS-101 beneficiary, who is receiving. Carries the person identity plus
 * the on-chain account(s) the value moves to.
 */
export interface IvmsBeneficiary {
  beneficiaryPersons: IvmsPerson[];
  /** Destination Sui address(es). */
  accountNumber: string[];
}

/**
 * The IVMS-101 envelope a Travel Rule network transmits between VASPs. The
 * `originatingVASP` / `beneficiaryVASP` legs identify the institutions; for
 * UNHOSTED transfers the beneficiary VASP is absent.
 */
export interface Ivms101Payload {
  originator: IvmsOriginator;
  beneficiary: IvmsBeneficiary;
  originatingVASP?: IvmsPerson;
  beneficiaryVASP?: IvmsPerson;
}

// ───────────────────────────────────────────────────────────────────
// Threshold + routing
// ───────────────────────────────────────────────────────────────────

/**
 * FATF Travel Rule threshold in USD. Above this, originator/beneficiary data
 * must be exchanged for EXTERNAL_VASP transfers (and beneficiary
 * self-declaration collected for UNHOSTED). Most jurisdictions land near
 * $1,000; Korea's is ~KRW 1,000,000 (≈ this). Per-corridor overrides should
 * be layered on top of this default by the risk-tier engine, not hardcoded
 * into call sites.
 */
export const THRESHOLD_USD = 1000;

/** Whether a given USD amount meets or exceeds the Travel Rule threshold. */
export function isAboveThreshold(amountUsd: number): boolean {
  return Number.isFinite(amountUsd) && amountUsd >= THRESHOLD_USD;
}

/**
 * What kind of counterparty the beneficiary address belongs to. The caller
 * (a future pre-broadcast screening gate) is expected to resolve this, a
 * Talise-owned address is INTERNAL; a known exchange/custodial address is
 * EXTERNAL_VASP; anything else is treated as UNHOSTED.
 */
export type RecipientKind = "talise" | "external_vasp" | "unhosted";

/** The Travel Rule route a transfer takes. */
export type TravelRuleRoute = "INTERNAL" | "EXTERNAL_VASP" | "UNHOSTED";

/** The obligation a route carries once above threshold. */
export type TravelRuleObligation =
  | "NONE" // data stays in Talise's own ledger
  | "IVMS101_EXCHANGE" // transmit IVMS-101 to the beneficiary VASP
  | "BENEFICIARY_SELF_DECLARATION"; // unhosted-wallet self declaration

export interface RouteTransferInput {
  amountUsd: number;
  recipientKind: RecipientKind;
}

export interface RouteTransferDecision {
  route: TravelRuleRoute;
  aboveThreshold: boolean;
  /**
   * The obligation that applies. NONE for INTERNAL (data already with us) and
   * for any below-threshold transfer; the route-specific obligation otherwise.
   */
  obligation: TravelRuleObligation;
  /**
   * True when the caller must produce/transmit IVMS-101 (or collect a
   * self-declaration) before settlement. Convenience flag = obligation !==
   * "NONE".
   */
  requiresAction: boolean;
  /** Human-readable rationale, useful for audit logs + case management. */
  rationale: string;
}

/**
 * Classify a transfer into its Travel Rule route + obligation.
 *
 * Routing matrix:
 *   recipientKind  | below threshold | at/above threshold
 *   ---------------+-----------------+----------------------------------
 *   talise         | INTERNAL/NONE   | INTERNAL/NONE  (data in our ledger)
 *   external_vasp  | EXTERNAL/NONE   | EXTERNAL/IVMS101_EXCHANGE
 *   unhosted       | UNHOSTED/NONE   | UNHOSTED/BENEFICIARY_SELF_DECLARATION
 *
 * INTERNAL never needs an external message regardless of amount: both legs
 * are inside Talise, so the originator/beneficiary data is already on hand.
 * The threshold only gates the *external* obligations.
 */
export function routeTransfer(input: RouteTransferInput): RouteTransferDecision {
  const aboveThreshold = isAboveThreshold(input.amountUsd);

  if (input.recipientKind === "talise") {
    return {
      route: "INTERNAL",
      aboveThreshold,
      obligation: "NONE",
      requiresAction: false,
      rationale:
        "Talise→Talise transfer, originator/beneficiary data stays in Talise's own ledger; no external IVMS-101 message required.",
    };
  }

  if (input.recipientKind === "external_vasp") {
    const obligation: TravelRuleObligation = aboveThreshold
      ? "IVMS101_EXCHANGE"
      : "NONE";
    return {
      route: "EXTERNAL_VASP",
      aboveThreshold,
      obligation,
      requiresAction: aboveThreshold,
      rationale: aboveThreshold
        ? `Transfer to an external VASP at/above the $${THRESHOLD_USD} threshold, IVMS-101 must be exchanged via a Travel Rule network (with sunrise fallback if the counterparty is unreachable).`
        : `Transfer to an external VASP below the $${THRESHOLD_USD} threshold, no IVMS-101 exchange required.`,
    };
  }

  // unhosted
  const obligation: TravelRuleObligation = aboveThreshold
    ? "BENEFICIARY_SELF_DECLARATION"
    : "NONE";
  return {
    route: "UNHOSTED",
    aboveThreshold,
    obligation,
    requiresAction: aboveThreshold,
    rationale: aboveThreshold
      ? `Transfer to an unhosted (self-custodial) wallet at/above the $${THRESHOLD_USD} threshold, collect beneficiary self-declaration per local rules; no counterparty VASP to message.`
      : `Transfer to an unhosted wallet below the $${THRESHOLD_USD} threshold, no self-declaration required.`,
  };
}

// ───────────────────────────────────────────────────────────────────
// Travel Rule network client, Notabene-shaped STUB
//
// Notabene (https://notabene.id) is one of the leading Travel Rule networks.
// Its real flow is: (1) discover the beneficiary VASP for a destination
// address, (2) create a transfer with an IVMS-101 payload, (3) the
// counterparty accepts/rejects, (4) settlement proceeds (or a "sunrise"
// fallback applies when the counterparty isn't on the network).
//
// This is an interface + STUB implementation. No network calls are made;
// `submitTransferMessage` returns a deterministic stub result so the rest of
// the system can be wired and tested without a Notabene account. Swap
// `stubTravelRuleClient()` for a real adapter (env-gated, server-only) when
// the Notabene integration lands.
// ───────────────────────────────────────────────────────────────────

/** Outcome states for a submitted Travel Rule message. */
export type TravelRuleTransferStatus =
  | "PENDING" // awaiting counterparty action
  | "ACCEPTED" // beneficiary VASP accepted the IVMS-101 data
  | "REJECTED" // beneficiary VASP rejected
  | "SUNRISE" // counterparty not on the network; sunrise fallback applied
  | "STUBBED"; // produced by the stub client (no real network call)

export interface SubmitTransferMessageInput {
  /** Destination on-chain (Sui) address. */
  beneficiaryAddress: string;
  /** USD-denominated amount of the transfer. */
  amountUsd: number;
  /** The IVMS-101 originator/beneficiary payload to transmit. */
  ivms101: Ivms101Payload;
  /**
   * Optional caller-supplied idempotency key so a retried submit doesn't
   * create a duplicate transfer on the network.
   */
  idempotencyKey?: string;
}

export interface SubmitTransferMessageResult {
  /** Network-side transfer id (stubbed id from the stub client). */
  transferId: string;
  status: TravelRuleTransferStatus;
  /** The beneficiary VASP DID/identifier if discovery resolved one. */
  beneficiaryVaspId?: string;
  /** Provider-specific detail / message. */
  detail?: string;
}

/**
 * Notabene-shaped Travel Rule network client. A real implementation wraps the
 * Notabene REST API (VASP discovery + transfer creation); the stub below
 * satisfies the interface without any network dependency.
 */
export interface TravelRuleClient {
  /**
   * Submit an IVMS-101 transfer message to the beneficiary VASP via the
   * Travel Rule network. Used only for EXTERNAL_VASP routes above threshold.
   */
  submitTransferMessage(
    input: SubmitTransferMessageInput,
  ): Promise<SubmitTransferMessageResult>;
}

/**
 * Stub Travel Rule client. Returns a deterministic STUBBED result, no
 * network call. Intended for development + tests until the real Notabene
 * adapter is implemented. Logs once per call so it's obvious a stub is in the
 * path if it ever leaks into a non-stub environment.
 */
export function stubTravelRuleClient(): TravelRuleClient {
  return {
    async submitTransferMessage(input) {
      const transferId = `stub_tr_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      return {
        transferId,
        status: "STUBBED",
        detail:
          "stubTravelRuleClient: no real Travel Rule network call was made. " +
          `Would transmit IVMS-101 for $${input.amountUsd} to ${input.beneficiaryAddress}. ` +
          "Replace with a real Notabene adapter before any external VASP transfer.",
      };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Persistence, travel_rule_records
//
// Above-threshold transfer metadata is captured for audit + case
// management. The table is defined idempotently in web/lib/db.ts
// ensureSchema(); this helper is the typed writer.
// ───────────────────────────────────────────────────────────────────

/** A persisted Travel Rule record (mirrors the travel_rule_records table). */
export interface TravelRuleRecord {
  id: number;
  user_id: number | null;
  route: TravelRuleRoute;
  obligation: TravelRuleObligation;
  amount_usd: number;
  recipient_kind: RecipientKind;
  beneficiary_address: string | null;
  /** Stringified IVMS-101 payload (JSON). NULL when not yet collected. */
  ivms101_json: string | null;
  /** Travel Rule network transfer id, once a message has been submitted. */
  network_transfer_id: string | null;
  status: TravelRuleTransferStatus | null;
  created_at: number;
}

export interface RecordTravelRuleInput {
  /** Talise user id of the originator, when known. */
  userId?: number | null;
  decision: RouteTransferDecision;
  recipientKind: RecipientKind;
  amountUsd: number;
  beneficiaryAddress?: string | null;
  ivms101?: Ivms101Payload | null;
  networkTransferId?: string | null;
  status?: TravelRuleTransferStatus | null;
}

/**
 * Persist an above-threshold transfer's Travel Rule metadata into
 * `travel_rule_records`. Below-threshold transfers don't need a record, but
 * the helper does not enforce that, the caller decides what to persist (an
 * audit program may want to log below-threshold external transfers too).
 *
 * Idempotency is the caller's responsibility (pass a stable
 * `networkTransferId` and de-dupe upstream if needed); this insert always
 * appends a new row.
 */
export async function recordTravelRuleTransfer(
  input: RecordTravelRuleInput,
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO travel_rule_records
      (user_id, route, obligation, amount_usd, recipient_kind,
       beneficiary_address, ivms101_json, network_transfer_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.userId ?? null,
      input.decision.route,
      input.decision.obligation,
      input.amountUsd,
      input.recipientKind,
      input.beneficiaryAddress ?? null,
      input.ivms101 ? JSON.stringify(input.ivms101) : null,
      input.networkTransferId ?? null,
      input.status ?? null,
      Date.now(),
    ],
  });
}

// ───────────────────────────────────────────────────────────────────
// Documented integration point (NOT wired in yet)
// ───────────────────────────────────────────────────────────────────

/**
 * TRAVEL_RULE_INTEGRATION_POINT
 *
 * Where this module plugs into the send path WHEN compliance is sequenced in
 * (master plan §7, P0 blocker, BEFORE any new corridor). Intentionally not
 * wired today; this is a pointer for the future pre-broadcast screening gate.
 *
 * Target: web/app/api/send/sponsor-prepare/route.ts, after the recipient
 * (`to`) and `amountNum` (USD; USDsui is 1:1) are validated and the user row
 * (`user`) is loaded, i.e. just before the PTB is built.
 *
 * Sketch:
 *
 *   import {
 *     routeTransfer,
 *     recordTravelRuleTransfer,
 *     stubTravelRuleClient,
 *     type RecipientKind,
 *   } from "@/lib/travel-rule";
 *
 *   // 1. Resolve who `to` belongs to. The risk-tier / address-screening
 *   //    engine (also unbuilt) decides this. Until it exists, every
 *   //    non-Talise address is conservatively treated as "unhosted".
 *   const recipientKind: RecipientKind = await resolveRecipientKind(to);
 *
 *   // 2. Classify.
 *   const decision = routeTransfer({ amountUsd: amountNum, recipientKind });
 *
 *   // 3. For above-threshold external transfers, transmit IVMS-101 and BLOCK
 *   //    settlement until the obligation is satisfied.
 *   if (decision.requiresAction) {
 *     if (decision.obligation === "IVMS101_EXCHANGE") {
 *       const client = stubTravelRuleClient(); // → real Notabene adapter
 *       const res = await client.submitTransferMessage({
 *         beneficiaryAddress: to,
 *         amountUsd: amountNum,
 *         ivms101: buildIvms101(user, to), // builder TBD
 *       });
 *       await recordTravelRuleTransfer({
 *         userId: user.id, decision, recipientKind, amountUsd: amountNum,
 *         beneficiaryAddress: to, networkTransferId: res.transferId,
 *         status: res.status,
 *       });
 *       if (res.status === "REJECTED") {
 *         return NextResponse.json({ error: "transfer not permitted" }, { status: 403 });
 *       }
 *     } else if (decision.obligation === "BENEFICIARY_SELF_DECLARATION") {
 *       // require the beneficiary self-declaration flow before proceeding
 *     }
 *   }
 *
 *   // 4. INTERNAL (Talise→Talise) and below-threshold transfers fall straight
 *   //    through to the existing build path with no external message.
 *
 * Prerequisites that must land first (all §7 P0): full KYC + source-of-funds
 * at onboarding, a recipient-kind resolver (Talise-address lookup + known-VASP
 * address list), and the real Notabene adapter.
 */
export const TRAVEL_RULE_INTEGRATION_POINT =
  "web/app/api/send/sponsor-prepare/route.ts, after recipient + amount validation, before PTB build";
