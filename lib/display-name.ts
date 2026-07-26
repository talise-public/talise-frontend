import "server-only";

import { db } from "./db";
import { formatHandle, formatHandleFull } from "./handle";
import { shortAddress } from "./format";
import { findReverseNameForOwner } from "./suins-lookup";
import { invalidate } from "./perf-cache";

/**
 * Reverse resolver: Sui address → the best human label we can show for it.
 *
 * `lib/suins.ts` goes forward (a name the user typed → an address). This goes
 * the other way, which is what every LIST needs: rows carry addresses, and a
 * row that prints `0xac1d…9df0` next to a row that prints `sele@talise.sui`
 * for the SAME person is the bug this exists to kill.
 *
 * Precedence, best label first:
 *
 *   1. TALISE HANDLE from our own `users` table (`sui_address` → `talise_username`).
 *      One indexed query for the whole batch. This is the common case: most
 *      counterparties in the app are other Talise users, and we already know
 *      their names without touching the chain.
 *   2. SUINS REVERSE RECORD, on chain. Covers a counterparty who is not a
 *      Talise user but owns a `.sui` name, and a Talise user whose row we
 *      somehow missed. Bounded (see BUDGET below) and memoized 5 minutes by
 *      `findReverseNameForOwner`.
 *   3. NOTHING. `get()` returns null and the caller falls back — to a stored
 *      handle snapshot if it has one, then to the truncated address, which is
 *      exactly what every client renders today.
 *
 * Two hard rules this module keeps:
 *
 *   • IT NEVER THROWS. Every leg is individually caught and the whole thing is
 *     wrapped. A display resolver must not be able to 500 a list of money.
 *   • IT NEVER FANS OUT. Callers hand over an array of addresses and get one
 *     map back. The DB leg is ONE round trip regardless of row count (the
 *     production pool is `max: 8` and shared with send/limit paths, so a
 *     query-per-row would be a real hazard, not a style nit).
 */

// ── Display form ────────────────────────────────────────────────────────────
//
// The app already renders Talise handles two ways and both are correct in their
// own place, so this is a caller choice rather than something to unify blindly:
//
//   "full"  → `sele@talise.sui`  — what `resolveRecipient` returns and what the
//                                  send + stream flows store and display.
//   "short" → `sele@talise`      — what the activity feed and chat already use.
//
// Pick the one the surface ALREADY shows. Mixing forms inside one list is the
// same class of ugliness as mixing names and addresses.
export type DisplayNameForm = "short" | "full";

export type ResolveDisplayNamesOptions = {
  /** Which handle form to render. Default `"full"`. */
  form?: DisplayNameForm;
  /** Allow the on-chain SuiNS leg at all. Default true. */
  chain?: boolean;
  /**
   * Max addresses to reverse-resolve ON CHAIN in one batch. Each costs up to
   * four `listOwnedObjects` pages plus a `getNameRecord` walk, so this stays
   * small: a 20-row list must not turn into 80 RPC calls. Addresses past the
   * budget simply have no name this render, and a later render (with a warm
   * memo cache for the ones we did do) picks up more.
   */
  chainBudget?: number;
  /** Wall-clock cap for the WHOLE on-chain leg. Default 1500ms. */
  timeoutMs?: number;
};

const DEFAULT_CHAIN_BUDGET = 6;
const DEFAULT_CHAIN_TIMEOUT_MS = 1_500;

/** Max addresses per `IN (...)` list; more than this is chunked. */
const DB_CHUNK = 100;
/** Hard ceiling on one call, so a pathological caller cannot walk the table. */
const MAX_ADDRESSES = 500;

// ── Per-address memo ────────────────────────────────────────────────────────
//
// Keyed by lowercased address. Holds the RESOLVED PARTS (bare username and/or
// full SuiNS name), not a rendered string, so one cache entry serves both
// display forms.
//
// TTLs are deliberately short. A user can claim a handle at any moment, and the
// worst failure mode here is a user who just claimed a name still seeing a
// truncated address, so misses expire fast. Hits are cheap to be slightly stale
// about: a name that resolved a minute ago still resolves.
const HIT_TTL_MS = 120_000;
const MISS_TTL_MS = 20_000;

type Parts = {
  /** Bare Talise username, when this address is a Talise user / holds our subname. */
  username: string | null;
  /** Full SuiNS name, when the label came from a root `.sui` reverse record. */
  suinsName: string | null;
};

type Entry = Parts & { expiresAt: number };

const cache = new Map<string, Entry>();

function peek(lower: string): Parts | null {
  const hit = cache.get(lower);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(lower);
    return null;
  }
  return { username: hit.username, suinsName: hit.suinsName };
}

function remember(lower: string, parts: Parts): void {
  const resolved = !!(parts.username || parts.suinsName);
  cache.set(lower, {
    ...parts,
    expiresAt: Date.now() + (resolved ? HIT_TTL_MS : MISS_TTL_MS),
  });
}

/**
 * Drop everything we cached for an address. Call after a handle claim or a
 * SuiNS retarget so the new name shows up immediately instead of after the
 * TTL. Also clears the on-chain reverse memo in `lib/perf-cache`.
 */
export function invalidateDisplayName(address: string | null | undefined): void {
  if (!address) return;
  const lower = address.toLowerCase();
  cache.delete(lower);
  invalidate(`reverse-suins:${lower}`);
  invalidate(`talise-subname:${lower}`);
}

function render(parts: Parts | null, form: DisplayNameForm): string | null {
  if (!parts) return null;
  if (parts.username) {
    return form === "short"
      ? formatHandle(parts.username)
      : formatHandleFull(parts.username);
  }
  // A root `.sui` name has no Talise form; show it as-is, the way
  // `resolveRecipient` already renders one.
  return parts.suinsName || null;
}

/**
 * The result of a batch resolve. Address-keyed, case-insensitive, and safe to
 * hold across a request.
 */
export type DisplayNames = {
  /** The resolved name for `address`, or null when we have nothing better. */
  get(address: string | null | undefined): string | null;
  /**
   * The label to actually print: live name → stored snapshot → truncated
   * address. `stored` is the handle a row captured at creation time; it is a
   * fallback, never a winner, because the live name is what is true now.
   */
  label(address: string | null | undefined, stored?: string | null): string;
  /** How many addresses resolved to a real name. */
  readonly size: number;
};

function makeResult(parts: Map<string, Parts>, form: DisplayNameForm): DisplayNames {
  // Arrow-bound so the result stays correct when a caller destructures it.
  const get = (address: string | null | undefined): string | null => {
    if (!address) return null;
    return render(parts.get(address.toLowerCase()) ?? null, form);
  };
  return {
    get,
    label(address, stored) {
      const live = get(address);
      if (live) return live;
      const snapshot = stored?.trim();
      if (snapshot) return snapshot;
      // 4/4 truncation, matching `resolveRecipient` and every client.
      return address ? shortAddress(address, 4, 4) : "";
    },
    get size() {
      return parts.size;
    },
  };
}

const EMPTY_PARTS = new Map<string, Parts>();

/**
 * Batch-resolve addresses to display names.
 *
 * Cost for N addresses, none cached: ONE database round trip (two if N > 100),
 * plus at most `chainBudget` on-chain reverse lookups under a single shared
 * timeout. Cost when the memo is warm: zero.
 *
 * Never throws. Never rejects.
 */
export async function resolveDisplayNames(
  addresses: Array<string | null | undefined>,
  opts: ResolveDisplayNamesOptions = {}
): Promise<DisplayNames> {
  const form = opts.form ?? "full";
  try {
    // Dedupe + normalize. Anything that is not a plausible address is dropped
    // here rather than sent to the DB.
    const lowers: string[] = [];
    const seen = new Set<string>();
    for (const a of addresses) {
      if (!a || typeof a !== "string") continue;
      const lower = a.trim().toLowerCase();
      if (!lower.startsWith("0x") || lower.length < 4) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      lowers.push(lower);
      if (lowers.length >= MAX_ADDRESSES) break;
    }
    if (lowers.length === 0) return makeResult(EMPTY_PARTS, form);

    const parts = new Map<string, Parts>();
    const misses: string[] = [];
    for (const lower of lowers) {
      const cached = peek(lower);
      if (cached) {
        if (cached.username || cached.suinsName) parts.set(lower, cached);
        // A cached MISS stays a miss for this render; that is the point of the
        // short miss TTL.
      } else {
        misses.push(lower);
      }
    }
    if (misses.length === 0) return makeResult(parts, form);

    // ── Leg 1: our own users table. One indexed query per chunk. ────────────
    const stillMissing: string[] = [];
    const fromDb = new Set<string>();
    for (let i = 0; i < misses.length; i += DB_CHUNK) {
      const chunk = misses.slice(i, i + DB_CHUNK);
      try {
        const placeholders = chunk.map(() => "?").join(",");
        const r = await db().execute({
          sql: `SELECT sui_address, talise_username FROM users
                  WHERE LOWER(sui_address) IN (${placeholders})
                    AND talise_username IS NOT NULL`,
          args: chunk,
        });
        for (const row of r.rows) {
          const lower = String(row.sui_address ?? "").toLowerCase();
          const uname = row.talise_username ? String(row.talise_username) : null;
          if (!lower || !uname) continue;
          const p: Parts = { username: uname, suinsName: `${uname}.talise.sui` };
          parts.set(lower, p);
          remember(lower, p);
          fromDb.add(lower);
        }
      } catch {
        // DB hiccup on a DISPLAY query: leave these unresolved and let the
        // chain leg (or the caller's address fallback) cover them. Never
        // rethrow, the caller is rendering a list, not moving money.
      }
    }
    for (const lower of misses) if (!fromDb.has(lower)) stillMissing.push(lower);

    // ── Leg 2: on-chain SuiNS reverse record, bounded. ──────────────────────
    if (opts.chain !== false && stillMissing.length > 0) {
      const budget = Math.max(0, opts.chainBudget ?? DEFAULT_CHAIN_BUDGET);
      const batch = stillMissing.slice(0, budget);
      if (batch.length > 0) {
        await withTimeout(
          Promise.all(
            batch.map(async (lower) => {
              const found = await findReverseNameForOwner(lower).catch(() => null);
              const p: Parts = found
                ? { username: found.username, suinsName: found.fullName }
                : { username: null, suinsName: null };
              if (found) parts.set(lower, p);
              remember(lower, p);
            })
          ),
          opts.timeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS
        );
      }
    }

    return makeResult(parts, form);
  } catch {
    // Belt and braces. Whatever went wrong, the caller gets an empty map and
    // every row falls back to the address it already had.
    return makeResult(EMPTY_PARTS, form);
  }
}

/**
 * Single-address convenience. Same precedence, same caching, same never-throws
 * contract. Returns null when there is no name — callers keep their own
 * truncated-address fallback.
 */
export async function resolveDisplayName(
  address: string | null | undefined,
  opts: ResolveDisplayNamesOptions = {}
): Promise<string | null> {
  const names = await resolveDisplayNames([address], opts);
  return names.get(address);
}

/**
 * Resolve, and pick the label for one address in one call: live name → stored
 * snapshot → truncated address.
 */
export async function displayLabelFor(
  address: string | null | undefined,
  stored?: string | null,
  opts: ResolveDisplayNamesOptions = {}
): Promise<string> {
  const names = await resolveDisplayNames([address], opts);
  return names.label(address, stored);
}

/**
 * Resolve without waiting past `ms`. Whatever has not come back is simply
 * absent from the map. Used where a read route has a latency budget it cares
 * about more than it cares about names.
 */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      }
    );
  });
}
