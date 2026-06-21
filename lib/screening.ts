import "server-only";

/**
 * Pre-broadcast compliance screening (master plan §7).
 *
 * Two independent legs, composed by `screenTransfer`:
 *
 *   1. NAME SANCTIONS — fuzzy match a counterparty name against a small
 *      embedded OFAC-style sample list. This is a HARD STOP and is
 *      FAIL-CLOSED: an explicit list hit blocks the transfer. The list
 *      here is a tiny illustrative sample; production swaps in the real
 *      OFAC SDN consolidated list (and any internal denylist) behind the
 *      same `SanctionsListProvider` interface — `screenName` never has to
 *      change. See `EMBEDDED_SANCTIONS_SAMPLE` below.
 *
 *   2. ADDRESS RISK — score an on-chain address through a transaction-
 *      monitoring provider (Chainalysis KYT / TRM Labs shape). This leg
 *      is FAIL-OPEN: a provider/transport error logs and ALLOWS the send
 *      so a vendor outage can't 500 every transfer. Only a successful
 *      response carrying `block: true` (or a severity at/above the block
 *      threshold) stops the transfer. The default implementation is a
 *      deterministic mock scorer; production swaps in the real vendor
 *      behind the same `AddressRiskProvider` interface.
 *
 * Nothing here is wired to the DB — screening is a pure, side-effect-free
 * gate that callers invoke before building/broadcasting a transaction.
 * The provider seams (`setSanctionsListProvider`, `setAddressRiskProvider`)
 * let infra swap in real vendors without touching call sites.
 */

// ───────────────────────────────────────────────────────────────────────
// Name sanctions leg
// ───────────────────────────────────────────────────────────────────────

/**
 * Source of sanctioned-party names. The embedded sample implements this;
 * production replaces it with a loader for the OFAC SDN consolidated list
 * (and any internal denylist) — same shape, so `screenName` is unchanged.
 */
export interface SanctionsListProvider {
  /** Returns the canonical list of sanctioned-party display names. */
  names(): readonly string[];
}

/**
 * Tiny illustrative OFAC-style sample. NOT the real consolidated list —
 * it exists so the matcher + hard-stop wiring are exercisable end-to-end.
 * Swap via `setSanctionsListProvider(realOfacLoader)` in production.
 */
const EMBEDDED_SANCTIONS_SAMPLE: readonly string[] = [
  "Vladimir Putin",
  "Kim Jong Un",
  "Bashar al-Assad",
  "Nicolas Maduro",
  "Ali Khamenei",
  "Joaquin Guzman Loera",
  "Viktor Bout",
  "Specially Designated National",
  "OFAC SDN Test Entity",
];

const embeddedProvider: SanctionsListProvider = {
  names: () => EMBEDDED_SANCTIONS_SAMPLE,
};

let sanctionsProvider: SanctionsListProvider = embeddedProvider;

/** Swap the sanctions list source (e.g. the real OFAC SDN loader). */
export function setSanctionsListProvider(p: SanctionsListProvider): void {
  sanctionsProvider = p;
}

/**
 * Normalize a name for comparison: lowercase, strip accents/diacritics,
 * collapse non-alphanumerics to single spaces, trim. This makes
 * "Bashar al-Assad" and "bashar  al assad" compare equal.
 */
function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    // Drop combining diacritical marks left behind by NFKD.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Classic Levenshtein edit distance (iterative, O(n·m) time, O(m) space). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Similarity ratio in [0,1] derived from edit distance, normalized by the
 * longer string's length. 1 == identical, 0 == nothing in common.
 */
function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - levenshtein(a, b) / longer;
}

/**
 * Fuzzy-match threshold. At/above this ratio a candidate counts as a hit.
 * 0.88 tolerates transliteration/typo variance (e.g. "Bashar al Asad" vs
 * "Bashar al-Assad") while staying tight enough to avoid matching ordinary
 * unrelated names. Tune alongside the real list.
 */
const NAME_MATCH_THRESHOLD = 0.88;

export interface NameScreenHit {
  /** The sanctions-list entry that matched. */
  matched: string;
  /** Similarity ratio [0,1] of the best match. */
  score: number;
}

/**
 * Screen a single counterparty name against the configured sanctions list.
 * Returns the best hit at/above threshold, or `null` if clear. Pure.
 */
export function screenName(name: string | null | undefined): NameScreenHit | null {
  if (!name) return null;
  const needle = normalizeName(name);
  if (!needle) return null;

  let best: NameScreenHit | null = null;
  for (const entry of sanctionsProvider.names()) {
    const hay = normalizeName(entry);
    if (!hay) continue;
    // Exact normalized equality OR substring containment is an immediate,
    // top-confidence hit (covers "Specially Designated National" appearing
    // inside a longer free-text field).
    let score: number;
    if (hay === needle || needle.includes(hay) || hay.includes(needle)) {
      score = 1;
    } else {
      score = similarity(needle, hay);
    }
    if (score >= NAME_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { matched: entry, score };
    }
  }
  return best;
}

// ───────────────────────────────────────────────────────────────────────
// On-chain address risk leg
// ───────────────────────────────────────────────────────────────────────

export type RiskSeverity = "none" | "low" | "medium" | "high" | "severe";

/**
 * Normalized result shape for an address-risk lookup, modeled on the
 * Chainalysis KYT / TRM Labs response envelopes (a numeric score plus a
 * severity bucket plus a vendor-side block recommendation).
 */
export interface AddressRiskResult {
  /** Risk score, 0 (clean) … 100 (worst). */
  score: number;
  severity: RiskSeverity;
  /** Vendor-side recommendation to block this counterparty. */
  block: boolean;
  /** Optional human-readable category (e.g. "sanctioned", "mixer"). */
  category?: string;
}

/**
 * Provider seam for on-chain address risk. The mock below implements this;
 * production swaps in a Chainalysis KYT / TRM client behind the same
 * interface via `setAddressRiskProvider`. Implementations MAY throw on a
 * transport/provider error — `screenTransfer` catches and FAILS OPEN.
 */
export interface AddressRiskProvider {
  assess(address: string): Promise<AddressRiskResult>;
}

/** Map a numeric score to a severity bucket. */
function severityForScore(score: number): RiskSeverity {
  if (score >= 90) return "severe";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  if (score >= 10) return "low";
  return "none";
}

/**
 * Severity at/above which a successful risk response blocks the transfer.
 * "high" and "severe" block; "medium" and below are allowed (logged by the
 * caller if it cares). Production may lower this once the real provider's
 * scoring is calibrated against false-positive rates.
 */
const RISK_BLOCK_SEVERITIES: ReadonlySet<RiskSeverity> = new Set<RiskSeverity>([
  "high",
  "severe",
]);

/**
 * Deterministic mock scorer. Real interface, fake numbers: derives a stable
 * pseudo-score from the address bytes so the same address always returns the
 * same result (useful for tests and demos) without any network call.
 *
 * A couple of well-known burn/zero addresses are pinned to "severe" so the
 * hard-stop path is exercisable; everything else lands in the clean band.
 */
const PINNED_SEVERE = new Set<string>([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
]);

const mockProvider: AddressRiskProvider = {
  async assess(address: string): Promise<AddressRiskResult> {
    const addr = address.trim().toLowerCase();
    if (PINNED_SEVERE.has(addr)) {
      return {
        score: 99,
        severity: "severe",
        block: true,
        category: "sanctioned",
      };
    }
    // Stable hash → low-band score for ordinary addresses. The mock never
    // blocks a real-looking address; only the pinned set above blocks.
    let h = 0;
    for (let i = 0; i < addr.length; i++) {
      h = (h * 31 + addr.charCodeAt(i)) >>> 0;
    }
    const score = h % 10; // 0..9 → severity "none"
    return {
      score,
      severity: severityForScore(score),
      block: false,
    };
  },
};

let riskProvider: AddressRiskProvider = mockProvider;

/** Swap the address-risk source (e.g. a Chainalysis KYT / TRM client). */
export function setAddressRiskProvider(p: AddressRiskProvider): void {
  riskProvider = p;
}

// ───────────────────────────────────────────────────────────────────────
// Composed transfer screen
// ───────────────────────────────────────────────────────────────────────

export interface ScreenTransferInput {
  senderAddr: string;
  recipientAddr: string;
  senderName?: string | null;
  recipientName?: string | null;
}

export interface ScreenTransferResult {
  allow: boolean;
  /** Present iff `allow === false`. Safe to surface to clients/logs. */
  reason?: string;
  /** Machine-readable cause for analytics. */
  cause?: "sanctioned-name" | "address-risk";
}

/**
 * Screen a transfer before it is built/broadcast. Returns `{allow:false}`
 * with a `reason` on a block, else `{allow:true}`.
 *
 * Failure semantics:
 *   • NAME leg — FAIL CLOSED. An explicit sanctions-list name hit (sender
 *     OR recipient) blocks. The list lookup is in-process and pure, so
 *     there's no transport to fail; a hit is authoritative.
 *   • ADDRESS leg — FAIL OPEN. A provider/transport error is logged and the
 *     send is ALLOWED, so a vendor outage can't 500 every transfer. Only a
 *     successful response recommending a block (`block:true` or a severity
 *     in `RISK_BLOCK_SEVERITIES`) stops the transfer.
 *
 * Name leg runs first: a sanctioned-name hit is the strongest signal and
 * needs no network call, so we short-circuit before touching the risk
 * provider.
 */
export async function screenTransfer(
  input: ScreenTransferInput
): Promise<ScreenTransferResult> {
  // 1) Name sanctions — fail-closed hard stop.
  const senderNameHit = screenName(input.senderName);
  if (senderNameHit) {
    return {
      allow: false,
      cause: "sanctioned-name",
      reason: `Sender name matches a sanctioned party (${senderNameHit.matched}).`,
    };
  }
  const recipientNameHit = screenName(input.recipientName);
  if (recipientNameHit) {
    return {
      allow: false,
      cause: "sanctioned-name",
      reason: `Recipient name matches a sanctioned party (${recipientNameHit.matched}).`,
    };
  }

  // 2) Address risk — fail-open. Assess both counterparties; a single
  //    block recommendation stops the transfer. Any thrown error logs and
  //    allows (per the fail-open contract).
  for (const [label, addr] of [
    ["sender", input.senderAddr],
    ["recipient", input.recipientAddr],
  ] as const) {
    if (!addr) continue;
    let result: AddressRiskResult;
    try {
      result = await riskProvider.assess(addr);
    } catch (err) {
      // FAIL OPEN: a vendor outage must not 500 every send.
      console.warn(
        `[screening] address-risk provider error for ${label}=${addr}; failing open (allowing). detail=${
          (err as Error)?.message ?? String(err)
        }`
      );
      continue;
    }
    if (result.block || RISK_BLOCK_SEVERITIES.has(result.severity)) {
      return {
        allow: false,
        cause: "address-risk",
        reason: `${label} address flagged ${result.severity} risk (score ${result.score}${
          result.category ? `, ${result.category}` : ""
        }).`,
      };
    }
  }

  return { allow: true };
}
