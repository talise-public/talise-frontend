import "server-only";

import { normalizeStructTag } from "@mysten/sui/utils";
import { USDSUI_TYPE } from "./usdsui";

// ─── Canonical coin types ──────────────────────────────────────────────────
//
// Sui GraphQL `balanceChangesJson` returns coin types in their FULL
// zero-padded address form (e.g.
// `0x0000…0002::sui::SUI`), whereas our constants (`"0x2::sui::SUI"`,
// `USDSUI_TYPE`) and on-chain event payloads can carry the SHORT form.
// A naive `===` compare therefore SILENTLY misses every native SUI /
// USDsui balance change, the activity feed then mislabeled real SUI/USDsui
// amounts as a generic "other coin" (amountSui/amountUsdsui null,
// otherCoin = SUI). `normalizeStructTag` zero-pads the address part so both
// forms collapse to one canonical string; we compare normalized-to-normalized
// everywhere a coin type meets these constants.
const SUI_TYPE = "0x2::sui::SUI";
const SUI_TYPE_N = normalizeStructTag(SUI_TYPE);
const USDSUI_TYPE_N = normalizeStructTag(USDSUI_TYPE);

/** Normalize a coin type for comparison; returns "" for falsy input. */
function normCoinType(t: string | undefined | null): string {
  if (!t) return "";
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
}
import { findTaliseSubnameForOwner } from "./suins-lookup";
import { formatHandle } from "./handle";
import {
  escrowAddress as chequeEscrowAddress,
  chequesEnabled,
  chequePackageId,
} from "./cheques";
import {
  streamEscrowAddress,
  streamEscrowEnabled,
  streamPackageId,
} from "./streams";
import { goalVaultPackageId } from "./goal-vault-ptb";
import { db } from "./db";
import { globalRegistryId, namespaceObjectId } from "./payment-kit";
import { parsePaymentKitNonce, type ParsedTaliseMemo } from "./intents/wrap-payment-kit";
import { batchCoinMetadata, suiGraphQL } from "./sui-graphql";
// Autoswap vault archived 2026-05-29, see `web/_archive/autoswap-2026-05-29/`.
// The vault-event walk below is now dormant: `opts.vaultId` is read from
// `users.talise_vault_id` which is no longer populated. We keep the merge
// path intact so historical rows already classified with direction:"autoswap"
// continue to dedupe correctly. The two stubs below replace the archived
// `./vault` imports so the runtime branch falls through as VaultNotDeployed.
class VaultNotDeployedError extends Error {
  constructor() {
    super("autoswap vault archived");
    this.name = "VaultNotDeployedError";
  }
}
function vaultPackageIds(): { packageId: string } {
  throw new VaultNotDeployedError();
}

/**
 * On-chain activity feed.
 *
 * We don't trust our local `tx_history` table as the source of truth -
 * inbound payments aren't recorded there at all, and outbound rows can be
 * lost across DB resets or failed write-backs. The chain has everything
 * we need: who sent what, to whom, when, in which coin.
 *
 * Approach per address:
 *   1. Query `suix_queryTransactionBlocks` twice, FromAddress + ToAddress
 *   2. Parse the `balanceChanges` block of each tx; isolate the user's
 *      net delta in USDsui (or SUI, for non-converted holdings).
 *   3. The counterparty is the other address with the inverse delta.
 *   4. Reverse-resolve the counterparty's `*.talise.sui` if they hold one,
 *      so the UI can render "from emma@talise" instead of `0xb9aa…866c`.
 *
 * Classification order per tx (most → least authoritative):
 *
 *   A. **Payment Kit PaymentRecord lookup**, if the tx created a
 *      `PaymentRecord<…>` dynamic field under the talise registry, we
 *      pull the nonce out of the `processRegistryPayment` MoveCall's
 *      arguments and parse it via `parsePaymentKitNonce`. A successful
 *      parse gives us the AUTHORITATIVE kind + venue + sender/receiver
 *    , the tx was originated by Talise and the on-chain memo carries
 *      everything we need.
 *
 *   B. **MoveCall package heuristic**, for pre-PK-wrapper txs (NAVI
 *      supply, DeepBook supply, etc. from before the wrapper landed),
 *      fall back to sniffing the venue's package id. Less authoritative
 *      but covers historical activity that doesn't have a PK record.
 *
 *   C. **Plain transfer**, direction from `balanceChanges` (the user's
 *      net USDsui/SUI delta is the sign).
 */

export type ActivityEntry = {
  digest: string;
  timestampMs: number;
  /**
   * Coarse motion direction, used by iOS for amount sign + tint.
   * `invest` and `withdraw` are direction-neutral (no counterparty
   * address), but iOS still wants a stable label for the History row.
   */
  direction: "sent" | "received" | "invest" | "withdraw" | "swap" | "autoswap";
  /** Net amount the user's address moved, in human units. Positive = received. */
  amountUsdsui: number | null;
  amountSui: number | null;
  /** Counterparty Sui address (or null for self / sponsor-only flows). */
  counterparty: string | null;
  /** Resolved `name@talise` display string, if the counterparty holds a Talise subname. */
  counterpartyName: string | null;
  /**
   * For invest/withdraw rows: which venue the tx interacted with -
   * e.g. "deepbook", "navi". Lets iOS show "Invested in DeepBook"
   * instead of just "Invested". Null for plain send/receive rows.
   */
  venue: string | null;
  /**
   * Semantic feature label for Talise's claimable-link (cheque) and streamed-
   * payment (stream) rails, derived purely from the COUNTERPARTY matching a
   * known escrow address (see `featureLabelFor`). When set, iOS/web can render
   * "Cheque issued" / "Stream funding" etc. instead of a generic Sent/Received.
   * Null for every ordinary transfer, and ALWAYS null when the cheque/stream
   * env (and therefore the escrow address) is unconfigured, labeling is
   * strictly additive and fail-open.
   */
  featureLabel:
    | "cheque_issued"
    | "cheque_claimed"
    | "stream_funding"
    | "stream_payment"
    | null;
  /**
   * Compound spend+save flag. When a Send PTB included a round-up
   * NAVI supply leg (Phase 2 v2), the tx digest has BOTH a `send`
   * and an `invest` PK PaymentRecord. We collapse them into ONE
   * activity row, `direction: "sent"`, `amountUsdsui` = the send
   * leg, and `roundupUsdsui` = the auto-saved portion. iOS renders
   * a "Sent + saved" row with both numbers visible.
   * Null on non-compound rows.
   */
  roundupUsdsui: number | null;
  /**
   * Non-USDsui / non-SUI coin movement. Populated when the user
   * sent or received a coin we don't already represent via
   * `amountUsdsui` / `amountSui` (e.g. WAL, USDC, USDT, random
   * meme coin). `amount` is the raw u64 value as a string so very
   * large numbers survive without precision loss; iOS formats it
   * with `decimals` for display.
   */
  otherCoin: {
    coinType: string;
    symbol: string;
    amount: string;
    decimals: number;
  } | null;
  /**
   * Set when this "sent" row is a USDsui → NGN bank CASH-OUT, i.e. the
   * recipient address matched one of the user's Linq off-ramp deposit
   * wallets. The activity route enriches it from `linq_offramps`. Lets the
   * UI label the row "Cash out → {bank}" and render a receipt with the NGN
   * figure, bank, and payout status instead of an anonymous "Sent".
   */
  offramp?: {
    provider: "linq";
    amountNgn: number;
    bankName: string | null;
    accountLast4: string | null;
    status: string;
    rate: number;
    orderId: string;
  } | null;
  /**
   * Set when this "sent" row's digest matches a TEAM payout batch (a saved
   * team paid in one PTB). The activity route enriches it from `payout_batches`.
   * Lets History render "Paid {name}" with a team icon and the recipient count,
   * instead of naming one arbitrary leg's recipient. Null for ordinary sends.
   */
  team?: {
    name: string;
    recipientCount: number;
  } | null;
};

/**
 * Per-process coin-info cache. CoinMetadata reads used to cost one RPC
 * round-trip per type; we now batch them via Sui GraphQL (one POST returns
 * every requested type via aliases). The cache still lives at module scope
 * so repeated refreshes of the activity feed avoid re-fetching even the
 * GraphQL batch.
 */
const coinInfoCache = new Map<string, { symbol: string; decimals: number }>();

/**
 * Resolve metadata for a set of coin types in one GraphQL hit, populating
 * the per-process cache. Already-cached types are skipped before the
 * network call, for steady-state refreshes this becomes a no-op.
 *
 * Falls back to a type-string symbol + 9 decimals on any error, matching
 * the legacy per-call behaviour.
 */
async function primeCoinInfo(coinTypes: string[]): Promise<void> {
  const missing = Array.from(
    new Set(coinTypes.filter((t) => t && !coinInfoCache.has(t)))
  );
  if (missing.length === 0) return;
  const batch = await batchCoinMetadata(missing);
  for (const t of missing) {
    const m = batch.get(t);
    coinInfoCache.set(
      t,
      m ?? { symbol: coinSymbolFromType(t), decimals: 9 }
    );
  }
}

function lookupCoinInfo(coinType: string): { symbol: string; decimals: number } {
  return (
    coinInfoCache.get(coinType) ?? {
      symbol: coinSymbolFromType(coinType),
      decimals: 9,
    }
  );
}

/** Last `::Name` segment of a Move type, uppercased. `WAL`, `USDC`. */
function coinSymbolFromType(coinType: string): string {
  const parts = coinType.split("::");
  const last = parts[parts.length - 1] || "COIN";
  return last.toUpperCase().slice(0, 12);
}

/**
 * Package IDs we recognize as "yield venues" for the heuristic fallback
 * (path B). Anything calling these, that didn't already classify via
 * the PK PaymentRecord (path A), gets tagged invest / withdraw.
 *
 * IDs were pulled directly from real mainnet user txs (mid-2026):
 *
 * - DeepBook margin: v1 anchor (0x97d9…fb86b, original type-anchor),
 *   the post-upgrade package (0x124b…ff2e, current), and an
 *   intermediate id (0xfbd3…1377). We match all three so neither
 *   pre-upgrade caps nor newly minted ones slip through unlabelled.
 *
 * - NAVI: lending v3 lives in `incentive_v3::*` (entry_deposit /
 *   withdraw_v2 etc.) under 0x1e4a13a0494d…. Oracle prelude
 *   (oracle_pro::update_single_price_v2) is noise we intentionally
 *   don't tag as a "venue", the real NAVI call always follows it in
 *   the same PTB and is what we classify.
 */
const VENUE_PACKAGES: Array<{ pkg: string; venue: string }> = [
  // DeepBook margin protocol, original (v1) and upgraded ids.
  { pkg: "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b", venue: "deepbook" },
  { pkg: "0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377", venue: "deepbook" },
  { pkg: "0x124bb3d8105d6d301c0d40feaa54d65df6b301e4d8ddd5eb8475b0f8a18cff2e", venue: "deepbook" },
  // NAVI lending, incentive_v3 module.
  { pkg: "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb", venue: "navi" },
];

/// Function-name substrings that flip a venue call into "withdraw".
/// Everything else under a venue package (entry_deposit, supply,
/// mint_supplier_cap, repay, …) folds into "invest" as the default -
/// better to over-tag as invest than mislabel as sent.
const WITHDRAW_FN_HINTS = ["withdraw", "redeem", "claim"];

function classifyVenue(tx: RawTx): { venue: string; kind: "invest" | "withdraw" } | null {
  const moveTxs = tx.transaction?.data?.transaction?.transactions ?? [];
  for (const t of moveTxs) {
    const call = t.MoveCall ?? t;
    const pkg = (call?.package ?? "").toLowerCase();
    const fn = (call?.function ?? "").toLowerCase();
    if (!pkg) continue;
    const hit = VENUE_PACKAGES.find((v) => v.pkg.toLowerCase() === pkg);
    if (!hit) continue;
    const isWithdraw = WITHDRAW_FN_HINTS.some((h) => fn.includes(h));
    return { venue: hit.venue, kind: isWithdraw ? "withdraw" : "invest" };
  }
  return null;
}

/**
 * Talise-OWNED Move modules (goal_vault, cheque, stream) we classify by
 * package id + module + function, a SECOND heuristic alongside
 * `classifyVenue` (NAVI/DeepBook). These rails don't always carry a PK
 * PaymentRecord (goal-vault deposit/withdraw is a direct `goal_vault::*`
 * MoveCall; cheque create/claim and stream create/claim are sponsored PTBs
 * with no `process_registry_payment` leg), so without this they fall through
 * to the plain send/received branch and render as an anonymous transfer to a
 * 0x escrow / vault id.
 *
 * FAIL-OPEN: each package id is read from env (`GOAL_VAULT_PACKAGE_ID`,
 * `CHEQUE_PACKAGE_ID`, `STREAM_PACKAGE_ID`). When an id is unset the
 * corresponding rail simply isn't matched, the feed still renders the row
 * via the downstream plain/heuristic path. Memoized per-process; the env is
 * fixed for a process lifetime.
 *
 * The mapping targets the fields iOS ALREADY renders (`direction` + `venue`)
 *, there is no new wire field. iOS shows `direction: "invest"` with a
 * `venue` string as "Invested in <Venue>" / "+ from <Venue>" (withdraw), and
 * a `venue` marker like "@handle" is special-cased in HistoryRow. We reuse
 * that contract: goal/cheque/stream get a stable, human venue code.
 */
let _taliseModulePkgs:
  | { goal: string | null; cheque: string | null; stream: string | null }
  | null = null;
function taliseModulePackages(): {
  goal: string | null;
  cheque: string | null;
  stream: string | null;
} {
  if (_taliseModulePkgs) return _taliseModulePkgs;
  let goal: string | null = null;
  let cheque: string | null = null;
  let stream: string | null = null;
  try {
    goal = goalVaultPackageId()?.toLowerCase() ?? null;
  } catch {
    goal = null;
  }
  try {
    cheque = chequePackageId()?.toLowerCase() ?? null;
  } catch {
    cheque = null;
  }
  try {
    stream = streamPackageId()?.toLowerCase() ?? null;
  } catch {
    stream = null;
  }
  _taliseModulePkgs = { goal, cheque, stream };
  return _taliseModulePkgs;
}

/**
 * Classify a Talise-owned-module tx (goal_vault / cheque / stream) into the
 * iOS-facing `direction` + `venue`. Returns null when the tx touches none of
 * the configured packages, caller then falls through to the next heuristic.
 *
 * Direction mapping (chosen so iOS's existing HistoryRow copy reads right):
 *   • goal_vault deposit / create_with  → invest, venue "goal"      ("Saved to a goal")
 *   • goal_vault withdraw / close        → withdraw, venue "goal"
 *   • goal_vault park_receipt (yield on) → invest, venue "navi" (yield engaged)
 *   • goal_vault take_receipt (yield off)→ withdraw, venue "navi"
 *   • cheque create                      → sent, venue "cheque"     (money parked in escrow)
 *   • cheque claim                       → received, venue "cheque"
 *   • cheque reclaim / reclaim_expired   → received, venue "cheque" (money back to issuer)
 *   • stream create                      → sent, venue "stream"     (funded)
 *   • stream claim_accrued               → received, venue "stream" (tranche pulled)
 *   • stream cancel_and_withdraw         → received, venue "stream" (refund of remainder)
 *
 * For the transfer-flavored rails (cheque / stream) we still want the row's
 * SIGN to follow the user's real balance delta, a claimer's USDsui goes UP,
 * an issuer's goes DOWN. We therefore return only the `venue` for those and
 * let the caller keep the balance-derived sent/received direction, EXCEPT we
 * pin direction when the move-call function unambiguously implies it. The
 * returned `direction` is advisory: the caller overrides it with the balance
 * sign for cheque/stream so a self-funded cheque (issuer) never mislabels.
 */
function classifyTaliseModule(tx: RawTx): {
  venue: string;
  direction: ActivityEntry["direction"];
  /** When true, the caller should keep the balance-sign direction and only
   *  adopt the venue (transfer-flavored rails: cheque/stream). */
  signFromBalance: boolean;
} | null {
  const { goal, cheque, stream } = taliseModulePackages();
  if (!goal && !cheque && !stream) return null;
  const moveTxs = tx.transaction?.data?.transaction?.transactions ?? [];
  for (const t of moveTxs) {
    const call = t.MoveCall ?? t;
    const pkg = (call?.package ?? "").toLowerCase();
    const mod = (call?.module ?? "").toLowerCase();
    const fn = (call?.function ?? "").toLowerCase();
    if (!pkg) continue;

    if (goal && pkg === goal && mod === "goal_vault") {
      // Yield engage/disengage via the parked NAVI AccountCap.
      if (fn === "park_receipt") {
        return { venue: "navi", direction: "invest", signFromBalance: false };
      }
      if (fn === "take_receipt") {
        return { venue: "navi", direction: "withdraw", signFromBalance: false };
      }
      // Withdraw / close pull USDsui back out of the segregated vault.
      if (fn.includes("withdraw") || fn === "close") {
        return { venue: "goal", direction: "withdraw", signFromBalance: false };
      }
      // create / create_with / deposit all push USDsui INTO the goal.
      if (fn === "deposit" || fn.startsWith("create")) {
        return { venue: "goal", direction: "invest", signFromBalance: false };
      }
      // Any other goal_vault call (e.g. yield-add), treat as invest.
      return { venue: "goal", direction: "invest", signFromBalance: false };
    }

    if (cheque && pkg === cheque && mod === "cheque") {
      // Claim/reclaim land money on the user; create parks it. Let the
      // balance sign decide direction so issuer vs claimer is always right.
      return { venue: "cheque", direction: "sent", signFromBalance: true };
    }

    if (stream && pkg === stream && mod === "stream") {
      // create funds (sender −), claim_accrued / cancel_and_withdraw pay
      // out (recipient/issuer +). Balance sign decides.
      return { venue: "stream", direction: "sent", signFromBalance: true };
    }
  }
  return null;
}

const SPONSOR_ADDRESSES = new Set<string>([
  "0x8a319488de2a8043a7b503d4a906ce5feedb793787bdb9a63bc6327d46310cdb",
]);

/**
 * Lazily-resolved, lowercased Talise escrow addresses for the cheque + stream
 * rails. FAIL-OPEN: if the env that gates either feature is unset (or the key
 * fails to decode), the corresponding address is null and labeling is simply
 * skipped, the feed still renders every row normally. Memoized per-process so
 * we don't re-derive the address on every activity request.
 */
let _escrowAddrs: { cheque: string | null; stream: string | null } | null = null;
function escrowAddresses(): { cheque: string | null; stream: string | null } {
  if (_escrowAddrs) return _escrowAddrs;
  let cheque: string | null = null;
  let stream: string | null = null;
  // `chequesEnabled()` / `streamEscrowEnabled()` only check the env flag; the
  // address derivation can still throw if the key is malformed, so guard both.
  try {
    if (chequesEnabled()) cheque = chequeEscrowAddress().toLowerCase();
  } catch {
    cheque = null;
  }
  try {
    if (streamEscrowEnabled()) stream = streamEscrowAddress().toLowerCase();
  } catch {
    stream = null;
  }
  _escrowAddrs = { cheque, stream };
  return _escrowAddrs;
}

/**
 * Map a transfer's counterparty + direction to a Talise feature label using
 * the escrow-address heuristic. Money LEAVING the user to the cheque escrow is
 * a cheque they ISSUED; money ARRIVING from it is a cheque CLAIM landing.
 * Same for the stream escrow (funding vs a tranche payment). Returns null for
 * any non-escrow counterparty, or whenever the addresses are unconfigured -
 * so this never changes behaviour for ordinary transfers.
 */
function featureLabelFor(
  counterparty: string | null,
  direction: ActivityEntry["direction"]
): ActivityEntry["featureLabel"] {
  if (!counterparty) return null;
  if (direction !== "sent" && direction !== "received") return null;
  const cp = counterparty.toLowerCase();
  const { cheque, stream } = escrowAddresses();
  if (cheque && cp === cheque) {
    return direction === "received" ? "cheque_claimed" : "cheque_issued";
  }
  if (stream && cp === stream) {
    return direction === "received" ? "stream_payment" : "stream_funding";
  }
  return null;
}

/**
 * Per-leg timeout helper. The activity feed has four independent legs
 * (tx history, vault events, counterparty names, coin metadata) each
 * fanning out into network calls with no upstream timeout. Without
 * fencing, a single slow GraphQL POST stalls the entire response past
 * the iOS URLSession 60s default and the client retries, which is
 * exactly the NSURLErrorTimedOut (-1001) we were chasing.
 *
 * Returns `fallback` and logs `[activity] <leg> timed out after Nms`
 * on timeout, so Vercel logs surface which leg wedged. Errors thrown
 * by the wrapped promise are NOT caught here, the caller already
 * has its own try/catch swallow with leg-appropriate empty fallback.
 */
function withTimeout<T>(p: Promise<T>, ms: number, leg: string, fallback: T): Promise<T> {
  const start = Date.now();
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[activity] ${leg} timed out after ${Date.now() - start}ms`);
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        console.warn(
          `[activity] ${leg} failed after ${Date.now() - start}ms: ${(e as Error).message}`
        );
        resolve(fallback);
      }
    );
  });
}

/**
 * Single GraphQL query that fetches the user's recent tx history
 * (both sent + received in ONE call, via `affectedAddress`).
 *
 * Pre-migration this site issued TWO `suix_queryTransactionBlocks`
 * calls in parallel (FromAddress + ToAddress) and unioned the results,
 * then merged in two more `suix_queryEvents` walks for vault deposits
 * / auto-swaps. GraphQL collapses the tx history into ONE round-trip;
 * the event walks each become ONE GraphQL paged loop instead of N
 * cursor-paged JSON-RPC calls.
 *
 * Schema note (2026 post-migration):
 *   The Sui mainnet GraphQL endpoint (`graphql.mainnet.sui.io`) uses
 *   the NEW schema: top-level query is `transactions` (not
 *   `transactionBlocks`), `transactionJson` lives on the Transaction
 *   node itself, and `balanceChangesJson` is on effects with a flat
 *   `{address, coinType, amount}` shape (no `owner.AddressOwner`
 *   wrapper). The `transactionJson.kind` payload also changed:
 *   programmable PTBs come back as
 *   `{kind: "PROGRAMMABLE_TRANSACTION", programmableTransaction: { inputs, commands }}`
 *   with `commands[].moveCall` (lowercase) and `arguments[].kind === "INPUT"`
 *   pointing at `.input` index slots. `inputs[].kind` is `"PURE"` /
 *   `"SHARED"` / etc., and PURE values come back as **base64-encoded
 *   BCS** in the `.pure` field (NOT the legacy decoded `.value`).
 *   `adaptGraphQLNodeToRawTx` normalizes ALL of this back to the
 *   legacy `RawTx` shape so the classifier downstream is untouched.
 */
const TX_HISTORY_QUERY = /* GraphQL */ `
  query ActivityHistory(
    $addr: SuiAddress!
    $last: Int!
    $before: String
  ) {
    transactions(
      filter: { affectedAddress: $addr }
      last: $last
      before: $before
    ) {
      pageInfo {
        hasPreviousPage
        startCursor
      }
      nodes {
        digest
        transactionJson
        effects {
          status
          timestamp
          balanceChangesJson
          objectChanges(first: 50) {
            nodes {
              idCreated
              idDeleted
              outputState {
                address
                owner {
                  __typename
                  ... on AddressOwner {
                    address {
                      address
                    }
                  }
                  ... on ObjectOwner {
                    address {
                      address
                    }
                  }
                }
                asMoveObject {
                  contents {
                    type {
                      repr
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type GraphQLActivityNode = {
  digest: string;
  transactionJson: unknown | null;
  effects: {
    status: string | null;
    timestamp: string | null;
    balanceChangesJson: unknown | null;
    objectChanges: {
      nodes: Array<{
        idCreated: boolean | null;
        idDeleted: boolean | null;
        outputState: {
          address: string;
          owner:
            | { __typename: "AddressOwner"; address: { address: string } | null }
            | { __typename: "ObjectOwner"; address: { address: string } | null }
            | { __typename: string }
            | null;
          asMoveObject: {
            contents: { type: { repr: string } | null } | null;
          } | null;
        } | null;
      }>;
    } | null;
  } | null;
};

type GraphQLActivityResponse = {
  transactions: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: Array<GraphQLActivityNode>;
  } | null;
};

/**
 * One GraphQL query for paginated event history, used by the vault-
 * event walk to pull `VaultDeposit` and `VaultAutoSwap` rows.
 *
 * The Sui GraphQL filter `type` accepts a full
 * `0x<pkg>::module::Event` string and matches exactly, same precision
 * as JSON-RPC's `MoveEventType` filter, with one round-trip per page.
 *
 * Schema note (2026 post-migration): the filter input is `type` (was
 * `eventType` in the older schema). `Event.contents` is now a typed
 * `MoveValue` directly, we keep reading `contents.json` because
 * `MoveValue.json` exists and serializes the parsed Move struct.
 */
const EVENTS_BY_TYPE_QUERY = /* GraphQL */ `
  query EventsByType(
    $eventType: String!
    $first: Int!
    $after: String
  ) {
    events(
      filter: { type: $eventType }
      first: $first
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        timestamp
        contents {
          json
        }
        transaction {
          digest
        }
      }
    }
  }
`;

type GraphQLEventsResponse<P> = {
  events: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      timestamp: string | null;
      contents: { json: P | null } | null;
      transaction: { digest: string } | null;
    }>;
  } | null;
};

/**
 * Adapt a single `transactionBlocks` node into the legacy `RawTx` shape
 * the classifier downstream already understands. We deliberately keep
 * the existing `RawTx` contract so the (long, well-tested) classifier
 * code doesn't need to be ported, we just rebuild the input it
 * expects.
 *
 * Two notable mappings:
 *   - `effects.status` is the GraphQL enum (`"SUCCESS"`/`"FAILURE"`)
 *     vs JSON-RPC's lowercase `"success"`. Normalize back to the
 *     lowercase form the classifier compares against.
 *   - `effects.timestamp` is RFC3339; convert to epoch-ms string to
 *     match the legacy `timestampMs` shape.
 */
function adaptGraphQLNodeToRawTx(node: GraphQLActivityNode): RawTx {
  const txJson = (node.transactionJson ?? {}) as Record<string, unknown>;

  // New schema `balanceChangesJson` is FLAT: `{address, coinType, amount}`.
  // Legacy classifier reads `b.owner.AddressOwner`, rebuild that wrapper.
  type FlatBalanceChange = {
    address?: string;
    coinType?: string;
    amount?: string;
  };
  const rawBalanceChanges = (node.effects?.balanceChangesJson ??
    []) as FlatBalanceChange[];
  const balanceChanges: NonNullable<RawTx["balanceChanges"]> =
    rawBalanceChanges.map((b) => ({
      owner: b.address ? { AddressOwner: b.address } : undefined,
      coinType: b.coinType,
      amount: b.amount,
    }));

  const statusRaw = (node.effects?.status ?? "").toString().toLowerCase();
  const ts = node.effects?.timestamp ? Date.parse(node.effects.timestamp) : 0;
  const tsMs = Number.isFinite(ts) ? ts : 0;

  // Project objectChanges into the JSON-RPC-style shape:
  //   { objectType, objectId, owner: { AddressOwner | ObjectOwner } }
  const objectChanges: RawObjectChange[] = [];
  for (const oc of node.effects?.objectChanges?.nodes ?? []) {
    const out = oc.outputState;
    if (!out) continue;
    const objectId = out.address;
    const objectType = out.asMoveObject?.contents?.type?.repr ?? undefined;
    let owner: RawObjectChange["owner"] = undefined;
    if (out.owner && typeof out.owner === "object") {
      if (out.owner.__typename === "AddressOwner") {
        const a = (out.owner as { address: { address: string } | null }).address
          ?.address;
        if (a) owner = { AddressOwner: a };
      } else if (out.owner.__typename === "ObjectOwner") {
        const a = (out.owner as { address: { address: string } | null }).address
          ?.address;
        if (a) owner = { ObjectOwner: a };
      } else if (out.owner.__typename === "Shared") {
        owner = { Shared: {} };
      }
    }
    objectChanges.push({
      type: oc.idCreated ? "created" : oc.idDeleted ? "deleted" : "mutated",
      objectId,
      objectType,
      owner,
    });
  }

  // `transactionJson` shape on the NEW mainnet schema:
  //   { kind: { kind: "PROGRAMMABLE_TRANSACTION",
  //             programmableTransaction: { inputs: [...], commands: [...] } } }
  // where each command is `{ moveCall: { package, module, function,
  // arguments: [{kind: "INPUT", input: 0}, ...], type_arguments: [...] } }`
  // and each input is `{ kind: "PURE", pure: "<b64>" }` /
  // `{ kind: "SHARED", objectId: ... }` / etc.
  //
  // The legacy classifier reads `transaction.data.transaction.{inputs,
  // transactions}` where each input is `{type: "pure"|"object",
  // value, ...}` and each transaction is `{MoveCall: {...}}`. We adapt
  // both layers here so downstream stays intact.
  type NewPtbInput = {
    kind?: string; // "PURE" | "SHARED" | "OWNED" | "IMMUTABLE" | "RECEIVING" | ...
    pure?: string; // base64-encoded BCS for PURE inputs
    objectId?: string;
    valueType?: string | null;
  };
  type NewMoveCallArg =
    | { kind: "INPUT"; input: number }
    | { kind: "RESULT"; result: number }
    | { kind: "NESTED_RESULT"; result: number; subresult: number }
    | { kind: "GAS_COIN" }
    | { kind: string };
  type NewMoveCall = {
    package?: string;
    module?: string;
    function?: string;
    arguments?: NewMoveCallArg[];
    type_arguments?: string[];
    typeArguments?: string[];
  };
  type NewPtbCommand = { moveCall?: NewMoveCall };
  type NewProgrammableTx = {
    inputs?: NewPtbInput[];
    commands?: NewPtbCommand[];
  };
  type NewTxKind = {
    kind?: string;
    programmableTransaction?: NewProgrammableTx;
  };

  // The whole `kind` block (new shape). Fall back to the legacy shape
  // (`txJson.transaction.{inputs,transactions}`) when present, so we
  // also work against the old schema in tests that mock fixtures.
  const newKind = (txJson.kind ?? {}) as NewTxKind;
  const newPt = newKind.programmableTransaction;

  let rawInputs: RawSuiCallArg[] = [];
  let rawTransactions: RawTransactionInput[] = [];
  let kindLabel: string | undefined;

  if (newPt) {
    kindLabel =
      typeof newKind.kind === "string" ? newKind.kind : "ProgrammableTransaction";
    rawInputs = (newPt.inputs ?? []).map((inp) => {
      if (inp.kind === "PURE") {
        // The classifier only reads pure values via `readPureString`
        // (expects a string OR number[] UTF-8 bytes) and
        // `readU64AsUsdsui` (expects string or number). We decode the
        // base64 to a number[] of bytes, `readPureString` then
        // round-trips via `Buffer.from(...).toString("utf8")`. For
        // u64 PaymentRecord amounts, `readU64AsUsdsui` reads the
        // pure value as a string; we additionally surface the
        // BCS-decoded little-endian u64 as the `value` string when
        // the byte array is exactly 8 long, so the existing
        // `Number(v)` parse downstream gets the right number.
        let bytes: number[] = [];
        try {
          bytes = Array.from(Buffer.from(inp.pure ?? "", "base64"));
        } catch {
          bytes = [];
        }
        let value: unknown = bytes;
        // BCS u64 is 8 little-endian bytes. Surface its decimal value
        // as a string so `readU64AsUsdsui` parses it cleanly (the
        // function does `Number(v)` and accepts string).
        if (bytes.length === 8) {
          let n = 0n;
          for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
          // Cap at Number.MAX_SAFE_INTEGER fidelity loss is fine, the
          // amounts we read here are micro-USDsui (<2^53 within any
          // realistic Talise tx). Emit a string so both readers
          // (string or BigInt) keep working.
          value = n.toString();
        } else if (bytes.length > 0) {
          // For string-typed pure inputs (Move `vector<u8>` as utf8
          // string, the nonce), BCS prefixes a ULEB128 length.
          // Decode the length prefix and slice the payload bytes;
          // `readPureString` will then `Buffer.from(...).toString("utf8")`
          // which yields the original string.
          // ULEB128 read:
          let i = 0;
          let lenU = 0;
          let shift = 0;
          while (i < bytes.length) {
            const b = bytes[i++];
            lenU |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7;
          }
          // Sanity: the remaining bytes should match the decoded length.
          if (lenU > 0 && i + lenU === bytes.length) {
            value = bytes.slice(i);
          } else {
            value = bytes;
          }
        }
        return {
          type: "pure",
          value,
          valueType: inp.valueType ?? null,
        } as RawSuiCallArg;
      }
      // Treat any non-pure input as an object reference, the
      // classifier only ever reads `pure` values, so this is purely
      // shape-preserving.
      return {
        type: "object",
        objectId: inp.objectId,
      } as RawSuiCallArg;
    });

    rawTransactions = (newPt.commands ?? []).map((cmd) => {
      const mc = cmd.moveCall;
      if (!mc) return {} as RawTransactionInput;
      const args: RawSuiArgument[] = (mc.arguments ?? []).map((a) => {
        if (!a || typeof a !== "object") return a as RawSuiArgument;
        switch (a.kind) {
          case "INPUT":
            return { Input: (a as { input: number }).input };
          case "GAS_COIN":
            return "GasCoin";
          case "RESULT":
            return { Result: (a as { result: number }).result };
          case "NESTED_RESULT":
            return {
              NestedResult: [
                (a as { result: number }).result,
                (a as { subresult: number }).subresult,
              ],
            };
          default:
            return a as unknown as RawSuiArgument;
        }
      });
      return {
        MoveCall: {
          package: mc.package,
          module: mc.module,
          function: mc.function,
          arguments: args,
          type_arguments: mc.type_arguments ?? mc.typeArguments,
        },
      };
    });
  } else {
    // Legacy fixture path, older schema or hand-built test data.
    type LegacyTxInner = {
      kind?: string;
      inputs?: RawSuiCallArg[];
      transactions?: RawTransactionInput[];
    };
    const legacy: LegacyTxInner =
      ((txJson.transaction as { data?: { transaction?: LegacyTxInner } })?.data
        ?.transaction as LegacyTxInner | undefined) ??
      (txJson.transaction as LegacyTxInner | undefined) ??
      (txJson as LegacyTxInner);
    kindLabel = typeof legacy?.kind === "string" ? legacy.kind : undefined;
    rawInputs = (legacy?.inputs ?? []) as RawSuiCallArg[];
    rawTransactions = (legacy?.transactions ?? []) as RawTransactionInput[];
  }

  return {
    digest: node.digest,
    timestampMs: tsMs ? String(tsMs) : "0",
    effects: { status: { status: statusRaw === "success" ? "success" : statusRaw } },
    balanceChanges,
    objectChanges,
    transaction: {
      data: {
        transaction: {
          kind: kindLabel,
          inputs: rawInputs,
          transactions: rawTransactions,
        },
      },
    },
  };
}

type RawObjectChange = {
  type?: string;
  objectType?: string;
  objectId?: string;
  owner?:
    | { AddressOwner?: string; ObjectOwner?: string; Shared?: unknown }
    | string;
};

/**
 * SuiArgument shape, either "GasCoin" (literal string), or an object
 * with `Input`/`Result`/`NestedResult` referencing other PTB slots. We
 * only care about `Input` (which indexes into the tx's `inputs[]`).
 */
type RawSuiArgument =
  | "GasCoin"
  | { Input?: number; Result?: number; NestedResult?: [number, number] };

type RawMoveCall = {
  package?: string;
  module?: string;
  function?: string;
  arguments?: RawSuiArgument[];
  type_arguments?: string[];
};

type RawTransactionInput = {
  MoveCall?: RawMoveCall;
  kind?: string;
  package?: string;
  module?: string;
  function?: string;
};

/**
 * SuiCallArg, one entry in the PTB's `inputs[]` array. `pure` inputs
 * carry the actual primitive value (string, number, bool, address). We
 * only need to read the `value` field when the input type is "pure".
 */
type RawSuiCallArg = {
  type?: "object" | "pure" | "fundsWithdrawal";
  value?: unknown;
  valueType?: string | null;
  objectId?: string;
};

type RawTx = {
  digest?: string;
  timestampMs?: string;
  effects?: { status?: { status?: string } };
  balanceChanges?: Array<{
    owner?: { AddressOwner?: string } | string;
    coinType?: string;
    amount?: string;
  }>;
  objectChanges?: RawObjectChange[];
  transaction?: {
    data?: {
      transaction?: {
        kind?: string;
        inputs?: RawSuiCallArg[];
        transactions?: RawTransactionInput[];
      };
    };
  };
};

type RawBalanceChange = NonNullable<RawTx["balanceChanges"]>[number];

function ownerOf(b: RawBalanceChange): string | null {
  if (!b.owner) return null;
  if (typeof b.owner === "string") return null;
  return b.owner.AddressOwner ?? null;
}

/** Split balance changes into per-(address × coin) deltas, ignoring sponsor moves. */
function summarize(
  tx: RawTx,
  myAddress: string
): {
  myUsdsui: number;
  mySui: number;
  /** Raw u64 deltas for non-USDsui / non-SUI coins. */
  myOtherRaw: Record<string, bigint>;
  counterparty: string | null;
} {
  const me = myAddress.toLowerCase();
  let myUsdsui = 0;
  let mySui = 0;
  // pick the largest non-self, non-sponsor counterparty by absolute USDsui (then SUI) movement
  const others: Record<string, { usdsui: number; sui: number }> = {};

  // Non-USDsui / non-SUI movements tracked separately so the feed can
  // surface "Received 10 WAL" rows. Keyed by coin type, value is raw
  // u64 string (signed by way of leading '-').
  const myOtherRaw: Record<string, bigint> = {};

  for (const b of tx.balanceChanges ?? []) {
    const owner = (ownerOf(b) ?? "").toLowerCase();
    if (!owner) continue;
    const amt = Number(b.amount ?? "0");
    const ct = normCoinType(b.coinType);
    if (ct === USDSUI_TYPE_N) {
      const human = amt / 1e6;
      if (owner === me) myUsdsui += human;
      else if (!SPONSOR_ADDRESSES.has(owner)) {
        others[owner] ??= { usdsui: 0, sui: 0 };
        others[owner].usdsui += human;
      }
    } else if (ct === SUI_TYPE_N) {
      const human = amt / 1e9;
      if (owner === me) mySui += human;
      else if (!SPONSOR_ADDRESSES.has(owner)) {
        others[owner] ??= { usdsui: 0, sui: 0 };
        others[owner].sui += human;
      }
    } else if (owner === me && b.coinType) {
      // Generic-coin tracking. We don't try to figure out a USD value;
      // iOS gets the raw amount + decimals and formats client-side.
      try {
        myOtherRaw[b.coinType] =
          (myOtherRaw[b.coinType] ?? 0n) + BigInt(b.amount ?? "0");
      } catch {
        /* skip non-numeric amounts, never expected, but defensive */
      }
    }
  }

  // Pick counterparty with the biggest opposing movement (largest abs USDsui, fallback SUI).
  let counterparty: string | null = null;
  let bestScore = 0;
  for (const [addr, d] of Object.entries(others)) {
    const score = Math.abs(d.usdsui) || Math.abs(d.sui);
    if (score > bestScore) {
      bestScore = score;
      counterparty = addr;
    }
  }

  return { myUsdsui, mySui, myOtherRaw, counterparty };
}

/**
 * True iff this transaction wrote a PaymentRecord dynamic field under the
 * Talise payment-kit registry. We detect this by inspecting `objectChanges`:
 * any object whose owner is `ObjectOwner == registryId` is a child dynamic
 * field of the registry, i.e. a PaymentRecord we minted. We also accept a
 * MoveCall against the payment-kit namespace package as a secondary signal,
 * which covers edge cases where the RPC elides the child object change
 * (e.g. when the registry is created inline in the same tx).
 */
function isTaliseTransaction(
  tx: RawTx,
  registryId: string,
  namespaceId: string
): boolean {
  const reg = registryId.toLowerCase();
  const ns = namespaceId.toLowerCase();
  for (const oc of tx.objectChanges ?? []) {
    const owner = oc.owner;
    if (owner && typeof owner !== "string") {
      const objOwner = owner.ObjectOwner;
      if (objOwner && objOwner.toLowerCase() === reg) return true;
    }
    // Also catch the registry itself being created/mutated in this tx, which
    // can happen on the first-ever payment that bootstraps the registry.
    if (oc.objectId && oc.objectId.toLowerCase() === reg) return true;
  }
  const moveTxs = tx.transaction?.data?.transaction?.transactions ?? [];
  for (const t of moveTxs) {
    const call = t.MoveCall ?? t;
    const pkg = (call?.package ?? "").toLowerCase();
    if (pkg && pkg === ns) return true;
  }
  return false;
}

/**
 * True iff `objectType` is a PaymentRecord under the payment-kit module
 * (any type-arg). Used to detect the authoritative PK-mint signal in
 * `objectChanges` without depending on a specific coin type-arg.
 *
 * On-chain shape: `<pkg>::payment_kit::PaymentRecord<<coinType>>`.
 */
function isPaymentRecordType(objectType: string | undefined): boolean {
  if (!objectType) return false;
  // Two on-chain shapes both count as a PaymentRecord write:
  //   1. `<pkg>::payment_kit::PaymentRecord<<coinType>>`, the record
  //      object itself, with its USDsui type-arg, when it appears as
  //      a direct object change.
  //   2. `0x2::dynamic_field::Field<<pkg>::payment_kit::PaymentKey<...>,
  //       <pkg>::payment_kit::PaymentRecord>`, the dynamic field
  //      wrapper under the registry; here PaymentRecord appears WITHOUT
  //      its type-arg (the `<` is followed by another type, not USDSUI).
  //
  // The earlier regex `PaymentRecord</` only matched shape (1), which
  // missed every real Navi supply tx because RPCs surface only the
  // dynamic-field wrapper. Now we accept BOTH shapes: PaymentRecord
  // followed by `<` (with type arg) OR `>` (no type arg, dynamic-field
  // close bracket).
  return /::payment_kit::PaymentRecord[<>]/.test(objectType);
}

/**
 * AUTHORITATIVE PATH (A), recover the Talise memo from a tx.
 *
 * Walks two layers of the tx in lockstep:
 *
 *   1. Confirm `objectChanges` has a PaymentRecord under `registryId`.
 *      Without this we don't trust the MoveCall path (a 3rd-party app
 *      could call the same PK package against a different registry).
 *
 *   2. Find the `processRegistryPayment` MoveCall (module=payment_kit,
 *      function=process_registry_payment). Its `arguments[1]` is the
 *      `nonce: String`, a pure input. We resolve the `Input: n` index
 *      into the PTB's `inputs[]` and read the pure `value` (a string).
 *
 *   3. Parse the string via `parsePaymentKitNonce`. If it returns null
 *      (e.g. the nonce is from a third-party invoice or a `v2` future
 *      format we don't understand), we fall through to the heuristic.
 *
 * Returns null when the tx isn't a Talise PK tx OR when we can find
 * the PaymentRecord object change but can't parse a v1 Talise memo
 * out of the nonce (rare, e.g. legacy invoice-slug payments).
 *
 * All data we read here is already in the `RawTx` that
 * `queryTransactionBlocks` returned (showObjectChanges + showInput) -
 * NO additional RPC round-trips per tx.
 */
/**
 * Parsed memo enriched with the on-chain USDsui amount extracted from
 * the same `processRegistryPayment` MoveCall's `paymentAmount` input.
 * Used to attribute amounts when a single tx has multiple PK legs (the
 * compound spend+save case from the Phase 2 v2 round-up flow).
 */
interface ParsedTaliseMemoWithAmount extends ParsedTaliseMemo {
  amountUsdsui: number;
}

/**
 * Read a `pure` input as a string OR a UTF-8 byte array (RPCs vary).
 * Returns null if neither form is present.
 */
function readPureString(input: RawSuiCallArg | undefined): string | null {
  if (!input || input.type !== "pure") return null;
  if (typeof input.value === "string") return input.value;
  if (Array.isArray(input.value)) {
    try {
      return Buffer.from(input.value as number[]).toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read a `pure` input as a u64 micro-USDsui amount and convert to
 * human USDsui (1:1 USD). Sui RPCs emit u64 as a JS string. Some
 * older fullnodes emit it as a number; handle both. Returns 0 on
 * failure rather than null, a zero-amount PK call should sort to
 * the back, not crash classification.
 */
function readU64AsUsdsui(input: RawSuiCallArg | undefined): number {
  if (!input || input.type !== "pure") return 0;
  const v = input.value;
  let micro = 0;
  if (typeof v === "string") {
    const n = Number(v);
    micro = Number.isFinite(n) ? n : 0;
  } else if (typeof v === "number") {
    micro = v;
  }
  return micro / 1e6;
}

/**
 * Walk EVERY `process_registry_payment` MoveCall in the tx and return
 * a parsed memo (with amount) for each one that's owned by the talise
 * registry. Used by the main classifier to detect the compound
 * spend+save case (a Send PTB built by `/api/send/prepare` when
 * round-up is on emits two PK calls in the same digest: one `send`,
 * one `invest`).
 *
 * Single-record txs hit this and the caller picks the only entry; the
 * structure is uniform so we don't branch.
 */
function parseAllTalisePaymentRecords(
  tx: RawTx,
  registryId: string
): ParsedTaliseMemoWithAmount[] {
  const reg = registryId.toLowerCase();

  // Gate on at least one PaymentRecord under the talise registry (so
  // third-party PK calls don't accidentally classify as Talise).
  let hasTalisePaymentRecord = false;
  for (const oc of tx.objectChanges ?? []) {
    const owner = oc.owner;
    if (!owner || typeof owner === "string") continue;
    const objOwner = owner.ObjectOwner;
    if (!objOwner || objOwner.toLowerCase() !== reg) continue;
    if (isPaymentRecordType(oc.objectType)) {
      hasTalisePaymentRecord = true;
      break;
    }
  }
  if (!hasTalisePaymentRecord) return [];

  const inputs = tx.transaction?.data?.transaction?.inputs ?? [];
  const moveTxs = tx.transaction?.data?.transaction?.transactions ?? [];

  const out: ParsedTaliseMemoWithAmount[] = [];
  for (const t of moveTxs) {
    const call = t.MoveCall;
    if (!call) continue;
    if (call.module !== "payment_kit") continue;
    if (call.function !== "process_registry_payment") continue;

    // process_registry_payment(registry, nonce, paymentAmount, coin, receiver)
    // args[1] = nonce (pure string), args[2] = paymentAmount (pure u64).
    const args = call.arguments ?? [];
    const nonceArg = args[1];
    const amountArg = args[2];
    if (!nonceArg || typeof nonceArg === "string") continue;
    const nonceIdx = nonceArg.Input;
    if (typeof nonceIdx !== "number") continue;
    const nonce = readPureString(inputs[nonceIdx]);
    if (!nonce) continue;
    const parsed = parsePaymentKitNonce(nonce);
    if (!parsed) continue;

    let amountUsdsui = 0;
    if (amountArg && typeof amountArg !== "string") {
      const amountIdx = amountArg.Input;
      if (typeof amountIdx === "number") {
        amountUsdsui = readU64AsUsdsui(inputs[amountIdx]);
      }
    }
    out.push({ ...parsed, amountUsdsui });
  }
  return out;
}

/** Back-compat wrapper, first memo only. Used by callers that don't
 *  care about the compound case (and to keep older code paths intact).
 */
function classifyFromPaymentRecord(
  tx: RawTx,
  registryId: string
): ParsedTaliseMemo | null {
  const all = parseAllTalisePaymentRecords(tx, registryId);
  return all[0] ?? null;
}

/**
 * Map a parsed Talise memo to the iOS-facing direction + venue. The
 * memo's `kind` is the canonical source of truth, the user explicitly
 * told us what this tx was when we built the nonce.
 *
 * Direction mapping:
 *   - send / split / recur / agent_pay → user's net delta sign (sent
 *     vs received from the user's POV, these are real transfers, so
 *     the user is either sender or receiver and direction follows from
 *     their balance change).
 *   - invest / swap → "invest" (yield-bound)
 *   - withdraw → "withdraw"
 */
function memoToClassification(
  memo: ParsedTaliseMemo,
  myUsdsui: number,
  mySui: number
): { direction: ActivityEntry["direction"]; venue: string | null } {
  switch (memo.kind) {
    case "invest":
      return { direction: "invest", venue: memo.refs.venue ?? null };
    case "withdraw":
      return { direction: "withdraw", venue: memo.refs.venue ?? null };
    case "swap":
      // Swap is value-conserving; for the activity row we treat it as
      // a generic non-transfer. iOS already special-cases swap when
      // we wire it up, fall back to "invest" tint for now (it's the
      // closest direction-neutral label we have).
      return { direction: "invest", venue: memo.refs.venue ?? null };
    case "send":
    case "split":
    case "recur":
    case "agent_pay":
    default: {
      const direction: ActivityEntry["direction"] =
        myUsdsui < 0 || mySui < 0 ? "sent" : "received";
      return { direction, venue: null };
    }
  }
}

/**
 * Walk the `talise::vault::VaultDeposit` and `talise::vault::VaultAutoSwap`
 * event streams (most-recent first) and return the deposits/auto-swaps
 * for `vaultId` as `ActivityEntry` rows.
 *
 * Why this exists: the wallet-side `queryTransactionBlocks` feed only
 * surfaces transactions touching the user's address. Once a user has
 * pointed their @handle at their vault, payments TO the handle land
 * as coins owned by the vault object id (NOT the user's address) -
 * invisible to the wallet feed. Same for the cron-driven auto-swap:
 * the Onara admin signs the tx, the vault id moves, the user is
 * nowhere in the balanceChanges.
 *
 * Event discovery:
 *   • Query each MoveEventType filter (`vault::VaultDeposit`,
 *     `vault::VaultAutoSwap`) descending, page-bounded so a long-lived
 *     package doesn't blow our render budget.
 *   • Filter `parsedJson.vault_id == vaultId` to keep only this user's
 *     events (the package emits these across every user).
 *   • Translate parsedJson into the `ActivityEntry` shape iOS already
 *     understands, `direction: "received"` for deposits, `"autoswap"`
 *     for swaps. HistoryRow already maps both correctly.
 */
async function getVaultEventActivity(
  vaultId: string,
  limit: number,
  packageId: string
): Promise<ActivityEntry[]> {
  type DepositJson = {
    vault_id?: string;
    coin_type?: string | number[];
    amount?: string | number;
    from?: string;
  };
  type AutoSwapJson = {
    vault_id?: string;
    from_type?: string | number[];
    to_type?: string | number[];
    from_amount?: string | number;
    to_amount?: string | number;
    ts_ms?: string | number;
  };

  const vaultNormalized = vaultId.toLowerCase();

  // We scan a bounded recent window, fetching ~limit * 4 events per
  // type matches the wallet-feed over-fetch. The package is shared
  // across every user so the per-vault hit rate is sparse; cap at 100
  // events scanned per type to keep the cron budget intact.
  const FETCH_LIMIT = Math.max(limit * 4, 50);
  const MAX_SCAN = 200;

  /**
   * `vector<u8>` move arg arrives over JSON-RPC as either a UTF-8
   * encoded string or a number[] (the wire format varies between
   * fullnode versions). Decode both to a plain string.
   */
  function decodeBytes(v: string | number[] | undefined): string {
    if (!v) return "";
    if (typeof v === "string") return v;
    try {
      return Buffer.from(v).toString("utf8");
    } catch {
      return "";
    }
  }

  function toBigInt(v: string | number | undefined): bigint {
    if (v === undefined) return 0n;
    try {
      return typeof v === "bigint" ? v : BigInt(v);
    } catch {
      return 0n;
    }
  }

  async function walk<P>(
    moveEventType: string,
    accept: (p: P) => boolean
  ): Promise<Array<{ digest: string; timestampMs: number; parsedJson: P }>> {
    const out: Array<{ digest: string; timestampMs: number; parsedJson: P }> = [];
    let cursor: string | null = null;
    let scanned = 0;
    const c = suiGraphQL();
    while (scanned < MAX_SCAN) {
      const pageLimit = Math.min(FETCH_LIMIT, MAX_SCAN - scanned);
      const res: { data?: GraphQLEventsResponse<P> } = await c.query({
        query: EVENTS_BY_TYPE_QUERY,
        variables: { eventType: moveEventType, first: pageLimit, after: cursor },
      });
      const page = res.data?.events;
      if (!page) break;
      for (const ev of page.nodes ?? []) {
        scanned++;
        const parsed = ev.contents?.json;
        if (!parsed) continue;
        if (!accept(parsed)) continue;
        const digest = ev.transaction?.digest;
        if (!digest) continue;
        const tsMs = ev.timestamp ? Date.parse(ev.timestamp) : 0;
        out.push({
          digest,
          timestampMs: Number.isFinite(tsMs) ? tsMs : 0,
          parsedJson: parsed,
        });
      }
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      cursor = page.pageInfo.endCursor;
    }
    return out;
  }

  let deposits: Array<{
    digest: string;
    timestampMs: number;
    parsedJson: DepositJson;
  }> = [];
  let autoSwaps: Array<{
    digest: string;
    timestampMs: number;
    parsedJson: AutoSwapJson;
  }> = [];
  try {
    [deposits, autoSwaps] = await Promise.all([
      walk<DepositJson>(`${packageId}::vault::VaultDeposit`, (p) =>
        (p.vault_id ?? "").toLowerCase() === vaultNormalized
      ),
      walk<AutoSwapJson>(`${packageId}::vault::VaultAutoSwap`, (p) =>
        (p.vault_id ?? "").toLowerCase() === vaultNormalized
      ),
    ]);
  } catch {
    return [];
  }

  // Resolve coin metadata for every non-USDsui/non-SUI coin that any
  // event references, in one GraphQL hit (`primeCoinInfo`'s cache is
  // shared with the wallet pass downstream).
  const otherTypes = new Set<string>();
  for (const d of deposits) {
    const t = decodeBytes(d.parsedJson.coin_type);
    if (t && t !== USDSUI_TYPE && t !== "0x2::sui::SUI") otherTypes.add(t);
  }
  for (const s of autoSwaps) {
    const f = decodeBytes(s.parsedJson.from_type);
    const to = decodeBytes(s.parsedJson.to_type);
    for (const t of [f, to]) {
      if (t && t !== USDSUI_TYPE && t !== "0x2::sui::SUI") otherTypes.add(t);
    }
  }
  if (otherTypes.size > 0) {
    await primeCoinInfo(Array.from(otherTypes));
  }

  const entries: ActivityEntry[] = [];

  for (const d of deposits) {
    const p = d.parsedJson;
    const coinType = decodeBytes(p.coin_type);
    const rawAmount = toBigInt(p.amount);
    if (rawAmount === 0n || !coinType) continue;

    let amountUsdsui: number | null = null;
    let amountSui: number | null = null;
    let otherCoin: ActivityEntry["otherCoin"] = null;
    if (coinType === USDSUI_TYPE) {
      amountUsdsui = Number(rawAmount) / 1e6;
    } else if (coinType === "0x2::sui::SUI") {
      amountSui = Number(rawAmount) / 1e9;
    } else {
      const info = lookupCoinInfo(coinType);
      otherCoin = {
        coinType,
        symbol: info.symbol,
        amount: rawAmount.toString(),
        decimals: info.decimals,
      };
    }

    entries.push({
      digest: d.digest,
      timestampMs: d.timestampMs,
      direction: "received",
      amountUsdsui,
      amountSui,
      counterparty: p.from ?? null,
      counterpartyName: null,
      // `venue: "@handle"` is a marker that the row is a vault-side
      // inbound transfer, HistoryRow already special-cases this so
      // the title reads "Received via @handle" instead of "Received".
      venue: "@handle",
      featureLabel: null,
      roundupUsdsui: null,
      otherCoin,
    });
  }

  for (const s of autoSwaps) {
    const p = s.parsedJson;
    const fromType = decodeBytes(p.from_type);
    const toType = decodeBytes(p.to_type);
    const fromAmount = toBigInt(p.from_amount);
    const toAmount = toBigInt(p.to_amount);
    if (fromAmount === 0n && toAmount === 0n) continue;

    // Compose the row so HistoryRow's "Swapped X → Y" path picks up
    // both legs. The source side fills `amountSui` (when it's SUI)
    // or `otherCoin` (anything else); the destination fills
    // `amountUsdsui` when the swap landed in USDsui, else `otherCoin`
    //, but the auto_swap path only ever produces USDsui today so
    // the common case is `(SUI|other) → USDsui`.
    let amountUsdsui: number | null = null;
    let amountSui: number | null = null;
    let otherCoin: ActivityEntry["otherCoin"] = null;
    let venue: string | null = null;

    if (fromType === "0x2::sui::SUI") {
      amountSui = Number(fromAmount) / 1e9;
    } else if (fromType && fromType !== USDSUI_TYPE) {
      const info = lookupCoinInfo(fromType);
      otherCoin = {
        coinType: fromType,
        symbol: info.symbol,
        amount: fromAmount.toString(),
        decimals: info.decimals,
      };
      // `venue` is the source coin symbol, HistoryRow renders
      // "Auto-swapped <SYMBOL>" when both legs aren't separately
      // formatted (rare, but the fallback exists in the iOS code).
      venue = info.symbol;
    } else if (fromType === USDSUI_TYPE) {
      // Reverse swap (USDsui → SUI / other), populate the USDsui
      // leg with the FROM amount so the composer renders correctly.
      amountUsdsui = Number(fromAmount) / 1e6;
    }

    if (toType === USDSUI_TYPE) {
      // Common case: USDsui is the destination. Overwrite any
      // amountUsdsui set above (the auto_swap module never emits
      // USDsui → USDsui so this branch + the from-USDsui branch
      // are mutually exclusive in practice).
      amountUsdsui = Number(toAmount) / 1e6;
    } else if (toType === "0x2::sui::SUI" && amountSui === null) {
      amountSui = Number(toAmount) / 1e9;
    } else if (toType && toType !== USDSUI_TYPE && otherCoin === null) {
      const info = lookupCoinInfo(toType);
      otherCoin = {
        coinType: toType,
        symbol: info.symbol,
        amount: toAmount.toString(),
        decimals: info.decimals,
      };
    }

    entries.push({
      digest: s.digest,
      timestampMs: s.timestampMs,
      direction: "autoswap",
      amountUsdsui,
      amountSui,
      counterparty: null,
      counterpartyName: null,
      venue,
      featureLabel: null,
      roundupUsdsui: null,
      otherCoin,
    });
  }

  return entries;
}

/**
 * `includeNonTalise: true` shows every successful USDsui / SUI movement
 * the address has been involved in, regardless of whether the tx flowed
 * through Talise's payment-kit registry. Used by the iOS /api/activity
 * feed (users want to see "money I received", they don't care about
 * which kit was used). The web feeds keep the curated default so the
 * Talise UI stays branded.
 *
 * `vaultId` opt: when set, we additionally walk the
 * `talise::vault::VaultDeposit` + `VaultAutoSwap` event streams for that
 * vault and merge the resulting rows into the wallet-side feed. Without
 * it, vault-side activity (auto-swap conversions, inbound payments to
 * @handle that land directly on the vault) would be invisible, the
 * wallet's tx history only sees txs touching the user's address.
 */
export async function getRecentActivity(
  address: string,
  limit = 12,
  opts: { includeNonTalise?: boolean; vaultId?: string | null } = {}
): Promise<ActivityEntry[]> {
  return (await getRecentActivityWithMeta(address, limit, opts)).entries;
}

/**
 * Same as `getRecentActivity`, plus a `complete` flag: false when the
 * tx-history leg timed out or failed and the entries are therefore a
 * PARTIAL (possibly empty) view of the chain. Feed-style callers can
 * ignore it, a short feed is still a feed, but AGGREGATING callers
 * (rewards insights) must not present sums computed from an incomplete
 * read as truth (same integrity principle as the 2026-06-11 balances
 * incident: a failed read is not a genuine zero).
 */
export async function getRecentActivityWithMeta(
  address: string,
  limit = 12,
  opts: { includeNonTalise?: boolean; vaultId?: string | null } = {}
): Promise<{ entries: ActivityEntry[]; complete: boolean }> {
  // We filter out non-Talise transactions client-side, so over-fetch by a
  // healthy margin to avoid an empty feed when a user has lots of unrelated
  // chain activity (NFT mints, random transfers, etc).
  const fetchLimit = Math.max(limit * 4, 50);
  // Sui GraphQL caps `first` at 50 (server-enforced
  // `Page size is too large: N > 50` validation error). Any `first` > 50
  // throws a GraphQL validation error which our broad try/catch below
  // swallowed, returning [], that was the root cause of the
  // "Nothing yet" / `decoded 0 entries` bug for addresses with a healthy
  // tx history when iOS asked for limit=20 (fetchLimit=80).
  //
  // Cap the per-page request at 50 and page forward until we either hit
  // the desired `fetchLimit` or exhaust the user's history. One extra
  // round-trip in the worst case; zero extra for users with <50 txs.
  const PAGE_MAX = 50;
  // Leg 1: tx-history GraphQL walk. Hard cap at 6s, past that we serve
  // whatever subset is in `raw` (possibly empty) and continue with the
  // remaining legs so iOS still gets vault rows / cached coin metadata.
  // Without this fence a hung GraphQL POST stalls the whole response
  // past iOS's 60s URLSession default and the client retries.
  const txHistoryWalk = async (): Promise<RawTx[]> => {
    const collected: RawTx[] = [];
    // Sui GraphQL's `transactions` connection orders ASCENDING (oldest
    // first). Paging forward with `first/after` therefore returns a user's
    // OLDEST txs and never reaches recent activity once they have more than
    // `fetchLimit` total, which froze History at the account's first ~50
    // txs. Page BACKWARD from the newest with `last/before` instead so the
    // most recent txs are always in the window. (Downstream sorts by
    // timestamp desc, so within-page order is irrelevant.)
    let before: string | null = null;
    let count = 0;
    while (count < fetchLimit) {
      const remaining = fetchLimit - count;
      const pageSize = Math.min(PAGE_MAX, remaining);
      // Pre-migration this site issued TWO `suix_queryTransactionBlocks`
      // calls in parallel (FromAddress + ToAddress) and unioned the
      // results client-side. Sui GraphQL's `affectedAddress` filter
      // returns BOTH sides in a single query, half the round-trips,
      // same coverage. The downstream classifier still consumes the
      // legacy `RawTx` shape; `adaptGraphQLNodeToRawTx` rebuilds it from
      // the `transactionJson` + `balanceChangesJson` + `objectChanges`
      // pieces.
      const res: { data?: GraphQLActivityResponse } = await suiGraphQL().query({
        query: TX_HISTORY_QUERY,
        variables: { addr: address, last: pageSize, before },
      });
      const page = res.data?.transactions;
      const nodes = page?.nodes ?? [];
      for (const n of nodes) collected.push(adaptGraphQLNodeToRawTx(n));
      count += nodes.length;
      if (!page?.pageInfo.hasPreviousPage || !page.pageInfo.startCursor) break;
      before = page.pageInfo.startCursor;
    }
    return collected;
  };
  // Sentinel fallback: `withTimeout` resolves this exact array on BOTH
  // timeout and rejection, so a reference compare distinguishes "the walk
  // finished (maybe genuinely empty)" from "the walk never finished".
  const TX_HISTORY_INCOMPLETE: RawTx[] = [];
  const raw: RawTx[] = await withTimeout(
    txHistoryWalk(),
    6_000,
    "tx-history",
    TX_HISTORY_INCOMPLETE
  );
  const complete = raw !== TX_HISTORY_INCOMPLETE;

  // Resolve the talise registry id once. If this throws (e.g. payment-kit
  // not initialized in this environment) we either show a fully-open feed
  // (mobile, opts.includeNonTalise=true) or degrade to empty (curated web).
  let registryId: string | null = null;
  let namespaceId: string | null = null;
  try {
    registryId = globalRegistryId();
    namespaceId = namespaceObjectId();
  } catch {
    if (!opts.includeNonTalise) return { entries: [], complete };
  }

  // Dedupe by digest. A tx can appear in both filters (e.g. a self-send).
  const byDigest = new Map<string, RawTx>();
  for (const tx of raw) {
    if (tx.digest && !byDigest.has(tx.digest)) byDigest.set(tx.digest, tx);
  }

  // Pre-pass: collect every non-USDsui/non-SUI coin type that any candidate
  // tx moved on the user's address, then issue ONE GraphQL batch lookup for
  // their CoinMetadata. The main classification loop downstream then reads
  // from `coinInfoCache` synchronously via `lookupCoinInfo`. Collapses N
  // per-coin `suix_getCoinMetadata` RPCs into one round-trip.
  {
    const allOtherCoinTypes = new Set<string>();
    for (const tx of byDigest.values()) {
      if (tx.effects?.status?.status !== "success") continue;
      for (const b of tx.balanceChanges ?? []) {
        if (!b.coinType) continue;
        const ct = normCoinType(b.coinType);
        if (ct === USDSUI_TYPE_N) continue;
        if (ct === SUI_TYPE_N) continue;
        const owner = (ownerOf(b) ?? "").toLowerCase();
        if (owner !== address.toLowerCase()) continue;
        allOtherCoinTypes.add(b.coinType);
      }
    }
    if (allOtherCoinTypes.size > 0) {
      // Leg 4: coin metadata prime, 2s cap. On timeout `lookupCoinInfo`
      // falls back to the last-segment-of-type symbol with 9 decimals,
      // so rows still render with a sensible label.
      await withTimeout(
        primeCoinInfo(Array.from(allOtherCoinTypes)),
        2_000,
        "coin-metadata",
        undefined
      );
    }
  }

  const entries: ActivityEntry[] = [];
  for (const tx of byDigest.values()) {
    if (tx.effects?.status?.status !== "success") continue;
    // Web (default): only surface txs that flowed through Talise's
    // payment-kit registry, keeps the curated feed clean.
    // Mobile (includeNonTalise=true): surface every successful USDsui
    // / SUI movement the address was involved in, so the user sees
    // their funding txs and direct transfers from outside Talise.
    if (!opts.includeNonTalise) {
      if (!registryId || !namespaceId) continue;
      if (!isTaliseTransaction(tx, registryId, namespaceId)) continue;
    }
    const { myUsdsui, mySui, myOtherRaw, counterparty } = summarize(tx, address);

    // Pick the dominant non-USDsui/non-SUI movement, if any. We pick the
    // single biggest by absolute raw value rather than emit one row per
    // coin type, multi-coin txs are dominated by one principal
    // transfer and a long tail of dust, so showing the big one keeps
    // the feed readable.
    const otherEntries = Object.entries(myOtherRaw).filter(
      ([, v]) => v !== 0n
    );
    otherEntries.sort((a, b) => {
      const aabs = a[1] < 0n ? -a[1] : a[1];
      const babs = b[1] < 0n ? -b[1] : b[1];
      return aabs < babs ? 1 : aabs > babs ? -1 : 0;
    });
    const dominantOther = otherEntries[0] ?? null;

    // Ignore txs where there is NO meaningful movement of any tracked
    // coin (sponsorship-only events, pure object reads, etc.).
    if (
      Math.abs(myUsdsui) < 0.0001 &&
      Math.abs(mySui) < 0.0001 &&
      !dominantOther
    ) {
      continue;
    }

    // --- Classification ------------------------------------------------
    // A. Authoritative, the on-chain PaymentRecord memo(s), if any.
    //    Compound case detected here: a tx with both a `send` PK
    //    record AND an `invest` PK record is the round-up flow, we
    //    surface it as a single "Sent + saved" row with the send
    //    amount as primary + the invest amount as `roundupUsdsui`.
    // B. Heuristic, venue package sniff (covers pre-PK history).
    // C. Plain, direction from balance-change sign.
    let direction: ActivityEntry["direction"];
    let venue: string | null = null;
    let cpForRow: string | null = counterparty;
    // Compound state, when set, the row carries both amounts.
    let compoundSendUsdsui: number | null = null;
    let compoundRoundupUsdsui: number | null = null;

    const allMemos = registryId
      ? parseAllTalisePaymentRecords(tx, registryId)
      : [];
    // Talise-owned-module heuristic (goal_vault / cheque / stream), computed
    // once and consumed only in the no-PK-memo branch below. Cheap when all
    // three package-id envs are unset (early return).
    const taliseModuleClass = classifyTaliseModule(tx);
    const sendMemo = allMemos.find((m) => m.kind === "send");
    const investMemo = allMemos.find((m) => m.kind === "invest");
    // Is the VIEWER the one who paid? The compound spend+save treatment
    // (and the "sent" direction) is only valid from the sender's POV -
    // their USDsui/SUI balance went DOWN. The recipient of the very same
    // digest sees a POSITIVE delta and must read it as "received".
    const viewerIsSender = myUsdsui < 0 || mySui < 0;

    if (sendMemo && investMemo && viewerIsSender) {
      // COMPOUND spend+save (sender's view). Use the send memo for
      // direction (the user thinks "I sent money to jude"); the invest
      // leg is surfaced as the round-up sub-amount.
      direction = "sent";
      venue = null;
      cpForRow = counterparty;
      compoundSendUsdsui = sendMemo.amountUsdsui;
      compoundRoundupUsdsui = investMemo.amountUsdsui;
    } else if (allMemos.length > 0) {
      // Single PK record, OR the RECIPIENT's view of a compound send+save
      // tx. Prefer the `send` memo so a recipient classifies off the real
      // transfer (→ "received" from their positive delta) instead of the
      // sender's round-up `invest` leg (which would mislabel it "invest").
      const memo = sendMemo ?? allMemos[0];
      const m = memoToClassification(memo, myUsdsui, mySui);
      direction = m.direction;
      venue = m.venue;
      if (direction === "invest" || direction === "withdraw") {
        cpForRow = null;
      }
    } else if (taliseModuleClass) {
      // B0. Talise-owned modules (goal_vault / cheque / stream). Checked
      //     BEFORE the generic NAVI/DeepBook venue sniff because a goal-vault
      //     yield tx also calls NAVI's package in the same PTB, we want the
      //     "goal"/"navi-yield" framing, not a bare "Invested in NAVI" that
      //     loses the goal context. Fail-open: null (and we fall to B/C)
      //     whenever the relevant package id env is unset.
      const tm = taliseModuleClass;
      venue = tm.venue;
      if (tm.signFromBalance) {
        // Transfer-flavored rail (cheque/stream): keep the balance-sign
        // direction so issuer (−) vs claimer (+) is always correct; only
        // adopt the venue label. cpForRow stays the escrow address so the
        // existing featureLabel heuristic can still fire as a secondary tag.
        direction = myUsdsui < 0 || mySui < 0 ? "sent" : "received";
      } else {
        // Goal vault / yield: direction-neutral invest|withdraw, no
        // counterparty (it's the user's own segregated vault).
        direction = tm.direction;
        cpForRow = null;
      }
    } else {
      // B. heuristic, match VENUE_PACKAGES against the MoveCalls.
      const venueClass = classifyVenue(tx);
      if (venueClass) {
        direction = venueClass.kind;
        venue = venueClass.venue;
        cpForRow = null;
      } else {
        // C. plain transfer (or swap). Detect swap first: when the
        // tx moves two different coins for the user in OPPOSITE
        // directions, it's almost certainly a DEX swap, the
        // legacy Convert-banner sweep, a direct Cetus call, the
        // vault's auto-swap PTB, etc. We surface this as a single
        // "swap" row with BOTH amounts visible instead of
        // mis-labeling it "Sent ₦X" using whichever leg's USD
        // value happens to be larger.
        //
        // Detection rules (any one triggers swap):
        //   • USDsui ↑ AND SUI ↓ in same tx, or vice versa
        //   • USDsui ↑ AND a non-USDsui non-SUI coin ↓ (or vice versa)
        //   • SUI ↑ AND a non-SUI non-USDsui coin ↓ (or vice versa)
        const hasOppositeUsdsuiSui =
          (myUsdsui > 0 && mySui < 0) ||
          (myUsdsui < 0 && mySui > 0);
        const hasOppositeUsdsuiOther =
          dominantOther !== null &&
          ((myUsdsui > 0 && dominantOther[1] < 0n) ||
            (myUsdsui < 0 && dominantOther[1] > 0n));
        const hasOppositeSuiOther =
          dominantOther !== null &&
          ((mySui > 0 && dominantOther[1] < 0n) ||
            (mySui < 0 && dominantOther[1] > 0n));
        if (
          hasOppositeUsdsuiSui ||
          hasOppositeUsdsuiOther ||
          hasOppositeSuiOther
        ) {
          direction = "swap";
          cpForRow = null;
        } else if (myUsdsui !== 0 || mySui !== 0) {
          direction = myUsdsui < 0 || mySui < 0 ? "sent" : "received";
        } else if (dominantOther) {
          direction = dominantOther[1] < 0n ? "sent" : "received";
        } else {
          direction = "received";
        }
      }
    }

    // For the compound case, override the amount with the send-leg
    // value rather than the user's total USDsui delta (which sums
    // send + roundup). The row needs to show "Sent ₦50" not "Sent ₦52".
    let entryAmountUsdsui: number | null;
    if (compoundSendUsdsui !== null) {
      entryAmountUsdsui = compoundSendUsdsui;
    } else {
      entryAmountUsdsui = myUsdsui === 0 ? null : Math.abs(myUsdsui);
    }

    // Build the otherCoin payload, only when (a) we tracked a non-
    // zero non-USDsui/non-SUI movement AND (b) USDsui/SUI didn't
    // already cover this row. Resolves coin metadata for the symbol +
    // decimals; falls back to last-segment-of-type if the chain has
    // no metadata registered for the coin.
    let otherCoin: ActivityEntry["otherCoin"] = null;
    if (dominantOther && entryAmountUsdsui === null && mySui === 0) {
      const [coinType, rawDelta] = dominantOther;
      const info = lookupCoinInfo(coinType);
      const absDelta = rawDelta < 0n ? -rawDelta : rawDelta;
      otherCoin = {
        coinType,
        symbol: info.symbol,
        amount: absDelta.toString(),
        decimals: info.decimals,
      };
    }

    // Cheque / stream escrow-address heuristic (fail-open: null when the
    // feature env is unset or the counterparty isn't an escrow address).
    const featureLabel = featureLabelFor(cpForRow, direction);

    entries.push({
      digest: tx.digest!,
      timestampMs: Number(tx.timestampMs ?? 0),
      direction,
      amountUsdsui: entryAmountUsdsui,
      amountSui: mySui === 0 ? null : Math.abs(mySui),
      counterparty: cpForRow,
      counterpartyName: null,
      venue,
      featureLabel,
      roundupUsdsui: compoundRoundupUsdsui,
      otherCoin,
    });
  }

  // Merge in vault-side events (deposits to the vault + auto-swap
  // conversions). These are emitted by the `talise::vault` Move module
  // and never appear in the user's wallet tx history, without this
  // pass the user can't see "money I received via @handle" nor the
  // cron-driven SUI→USDsui auto-swap.
  // Short-circuit: when the user has no vault id, skip the event walk
  // entirely, there's nothing to filter against and the bare
  // `events(filter: type)` query has no per-user predicate to lean on,
  // so it would walk the global stream for nothing. The `opts.vaultId`
  // truthiness check already guarded this; the explicit comment keeps
  // it from regressing.
  if (opts.vaultId) {
    try {
      const { packageId } = vaultPackageIds();
      // Leg 2: vault event walk (deposit + auto-swap in parallel).
      // 4s combined cap covers the Promise.all inside
      // `getVaultEventActivity`. On timeout we keep the wallet rows
      // we already classified.
      const vaultEntries = await withTimeout(
        getVaultEventActivity(opts.vaultId, limit, packageId),
        4_000,
        "vault-events",
        [] as ActivityEntry[]
      );
      for (const ve of vaultEntries) entries.push(ve);
    } catch (err) {
      if (!(err instanceof VaultNotDeployedError)) {
        // Soft-fail: vault module deployed but the event walk hiccuped.
        // Keep the wallet-side rows rather than failing the whole feed.
        console.warn(
          `[activity] vault-event walk failed: ${(err as Error).message}`
        );
      }
    }
  }

  // Sort newest first, then dedupe by digest. A single auto-swap tx
  // emits the `VaultAutoSwap` event AND moves coins on chain, if the
  // user's address is anywhere in the balanceChanges (e.g. fee rebate)
  // the same digest could appear on both the wallet-side and
  // vault-side pass. Vault rows win because their direction
  // ("autoswap"/"received via @handle") is more specific than the
  // generic wallet classification.
  entries.sort((a, b) => b.timestampMs - a.timestampMs);
  const seenDigests = new Set<string>();
  const merged: ActivityEntry[] = [];
  // Two-pass dedupe so a vault entry seen LATER in the sorted list (e.g.
  // identical timestampMs but stable sort kept the wallet row first)
  // still wins. Vault rows have direction "autoswap" or venue "@handle",
  // wallet duplicates of the same digest will not, so when we see a
  // duplicate digest, prefer the vault-flavored one.
  const vaultishFlavor = (e: ActivityEntry): boolean =>
    e.direction === "autoswap" || e.venue === "@handle";
  const byDigestPick = new Map<string, ActivityEntry>();
  for (const e of entries) {
    const prev = byDigestPick.get(e.digest);
    if (!prev) {
      byDigestPick.set(e.digest, e);
    } else if (vaultishFlavor(e) && !vaultishFlavor(prev)) {
      byDigestPick.set(e.digest, e);
    }
  }
  for (const e of entries) {
    if (seenDigests.has(e.digest)) continue;
    const winner = byDigestPick.get(e.digest);
    if (!winner) continue;
    seenDigests.add(e.digest);
    merged.push(winner);
  }
  const limited = merged.slice(0, limit);

  // Reverse-resolve unique counterparties to talise handles. One RPC per
  // unique address; cache within this render so we don't hit the same
  // address twice.
  const uniqueCounterparties = Array.from(
    new Set(limited.map((e) => e.counterparty).filter((x): x is string => !!x))
  );
  const nameCache = new Map<string, string | null>();

  // DB-first: the common case is paying ANOTHER Talise user, and we already
  // know every Talise user's address→handle in our own `users` table. Resolve
  // those in ONE indexed query instead of an up-to-4-page listOwnedObjects +
  // getNameRecord chain walk PER address. Only addresses NOT in our user base
  // fall through to the (slow) on-chain reverse-SuiNS resolution below.
  if (uniqueCounterparties.length > 0) {
    try {
      const byLower = new Map<string, string>(); // lower(addr) -> original counterparty string
      for (const a of uniqueCounterparties) byLower.set(a.toLowerCase(), a);
      const lowers = Array.from(byLower.keys());
      const placeholders = lowers.map(() => "?").join(",");
      const r = await db().execute({
        sql: `SELECT sui_address, talise_username FROM users
                WHERE LOWER(sui_address) IN (${placeholders})
                  AND talise_username IS NOT NULL`,
        args: lowers,
      });
      for (const row of r.rows) {
        const original = byLower.get(String(row.sui_address ?? "").toLowerCase());
        const uname = row.talise_username ? String(row.talise_username) : null;
        if (original && uname) nameCache.set(original, formatHandle(uname));
      }
    } catch {
      // Fall through, chain resolution below still covers everything.
    }
  }

  // Leg 3: counterparty-name fan-out for the addresses NOT resolved from the
  // DB above. 3s cap across the whole batch; on timeout every unresolved
  // address falls back to the truncated-address display iOS already renders
  // when `counterpartyName` is null. We don't time out individual addresses
  // because the SuiNS resolver has its own per-address memo cache.
  const unresolved = uniqueCounterparties.filter((addr) => !nameCache.has(addr));
  if (unresolved.length > 0) {
    await withTimeout(
      Promise.all(
        unresolved.map(async (addr) => {
          const sub = await findTaliseSubnameForOwner(addr);
          nameCache.set(addr, sub ? formatHandle(sub.username) : null);
        })
      ),
      3_000,
      "counterparty-names",
      [] as unknown[]
    );
  }
  for (const e of limited) {
    if (e.counterparty) e.counterpartyName = nameCache.get(e.counterparty) ?? null;
  }

  return { entries: limited, complete };
}
