/**
 * Waitlist handle-claim tests.
 *
 * These live alongside the mainnet integration suite because that's
 * the only Vitest config the repo currently wires up (`pnpm
 * test:integration`). They're hermetic — no network, no DB — so they
 * add zero wall-clock time to the suite.
 *
 * Coverage:
 *   1. `normalizeWaitlistHandle` — charset, length, reserved, common
 *      paste-formats (leading `@`, `.talise.sui` suffix).
 *   2. "claim flow" happy path — signed-in user POSTs the claim, the
 *      route mints via the (mocked) operator and writes both
 *      `claimed_handle` and `handle_bound_user_id` in one flow.
 *   3. "dup handle" race — two signed-in emails racing for the same
 *      handle: first wins, second 409s.
 *   4. "unauthenticated" — caller has no session → 401, no DB mutation.
 *   5. "mint failure rollback" — operator mint throws, the DB
 *      reservation is rolled back to NULL so the user can retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `next/server`'s `after()` throws "called outside a request scope" when
// the route runs outside Next's request lifecycle (i.e. in these unit
// tests). Stub it to run the callback inline so success-path claims that
// schedule the confirmation email don't blow up.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: unknown) => {
      if (typeof cb === "function") {
        try {
          void (cb as () => unknown)();
        } catch {
          /* swallow — mirrors after()'s detached semantics */
        }
      }
    },
  };
});

// ─── In-memory DB fake ────────────────────────────────────────────────────
//
// We model both `waitlist_signups` and `users`. The claim route now reads
// `users` to check the session and writes both tables on success.

type WaitlistRow = {
  email: string;
  created_at: number;
  claimed_handle: string | null;
  handle_claimed_at: number | null;
  handle_object_id: string | null;
  handle_bound_user_id: string | null;
  handle_bound_at: number | null;
};

type UserRow = {
  id: number;
  email: string;
  name: string | null;
  sui_address: string;
  talise_username: string | null;
};

const waitlistStore = new Map<string, WaitlistRow>();
const usersStore = new Map<number, UserRow>();

function seedWaitlist(email: string) {
  waitlistStore.set(email, {
    email,
    created_at: Date.now(),
    claimed_handle: null,
    handle_claimed_at: null,
    handle_object_id: null,
    handle_bound_user_id: null,
    handle_bound_at: null,
  });
}

function seedUser(opts: {
  id: number;
  email: string;
  suiAddress?: string;
}): UserRow {
  const row: UserRow = {
    id: opts.id,
    email: opts.email,
    name: null,
    sui_address: opts.suiAddress ?? `0x${opts.id.toString(16).padStart(64, "0")}`,
    talise_username: null,
  };
  usersStore.set(opts.id, row);
  return row;
}

function reset() {
  waitlistStore.clear();
  usersStore.clear();
}

// Mutable "current session" — tests flip this to simulate signed-in vs
// signed-out without dragging real cookies through the request layer.
let currentSessionUserId: number | null = null;

vi.mock("@/lib/session", () => ({
  readSessionEntryId: async () => currentSessionUserId,
}));

vi.mock("@/lib/db", () => {
  const execute = async (arg: {
    sql: string;
    args?: ReadonlyArray<unknown>;
  }) => {
    const sql = arg.sql.toLowerCase().replace(/\s+/g, " ").trim();
    const args = arg.args ?? [];

    // SELECT * FROM users WHERE id = ? LIMIT 1
    if (sql.startsWith("select * from users where id = ?")) {
      const id = Number(args[0]);
      const u = usersStore.get(id);
      return { rows: u ? [u] : [], rowsAffected: 0 };
    }

    // UPDATE users SET talise_username = NULL WHERE id = ? AND talise_username = ?
    // (rollback of the user-row reservation)
    if (
      sql.startsWith(
        "update users set talise_username = null where id = ? and talise_username = ?"
      )
    ) {
      const id = Number(args[0]);
      const handle = args[1] as string;
      const u = usersStore.get(id);
      if (u && u.talise_username === handle) {
        u.talise_username = null;
        return { rows: [], rowsAffected: 1 };
      }
      return { rows: [], rowsAffected: 0 };
    }

    // UPDATE users SET talise_username = ? WHERE id = ? AND talise_username IS NULL RETURNING ...
    // (conditional reservation — only writes when currently NULL, and the
    // global unique index rejects a value another user already owns)
    if (
      sql.startsWith("update users set talise_username = ? where id = ?") &&
      sql.includes("talise_username is null")
    ) {
      const handle = args[0] as string;
      const id = Number(args[1]);
      const u = usersStore.get(id);
      // Simulate the global unique index — another user already owns it.
      const conflict = [...usersStore.values()].find(
        (r) => r.id !== id && r.talise_username === handle
      );
      if (conflict) {
        throw new Error("UNIQUE constraint failed: users.talise_username");
      }
      // NULL-guard: only flip when currently NULL.
      if (!u || u.talise_username !== null) {
        return { rows: [], rowsAffected: 0 };
      }
      u.talise_username = handle;
      return { rows: [{ id, talise_username: handle }], rowsAffected: 1 };
    }

    // SELECT talise_username FROM users WHERE id = ? LIMIT 1
    if (
      sql.startsWith("select talise_username from users where id = ?")
    ) {
      const id = Number(args[0]);
      const u = usersStore.get(id);
      return {
        rows: u ? [{ talise_username: u.talise_username }] : [],
        rowsAffected: 0,
      };
    }

    // UPDATE users SET talise_username = ? WHERE id = ?  (plain, legacy)
    if (sql.startsWith("update users set talise_username = ? where id = ?")) {
      const handle = args[0] as string;
      const id = Number(args[1]);
      const u = usersStore.get(id);
      const conflict = [...usersStore.values()].find(
        (r) => r.id !== id && r.talise_username === handle
      );
      if (conflict) {
        throw new Error("UNIQUE constraint failed: users.talise_username");
      }
      if (u) u.talise_username = handle;
      return { rows: [], rowsAffected: u ? 1 : 0 };
    }

    // SELECT email FROM waitlist_signups WHERE claimed_handle = ? LIMIT 1
    if (
      sql.startsWith(
        "select email from waitlist_signups where claimed_handle = ?"
      )
    ) {
      const h = args[0] as string;
      const hit = [...waitlistStore.values()].find(
        (r) => r.claimed_handle === h
      );
      return { rows: hit ? [{ email: hit.email }] : [], rowsAffected: 0 };
    }

    // SELECT claimed_handle FROM waitlist_signups WHERE email = ? LIMIT 1
    if (
      sql.startsWith(
        "select claimed_handle from waitlist_signups where email = ?"
      )
    ) {
      const e = args[0] as string;
      const row = waitlistStore.get(e);
      if (!row) return { rows: [], rowsAffected: 0 };
      return {
        rows: [{ claimed_handle: row.claimed_handle }],
        rowsAffected: 1,
      };
    }

    // INSERT INTO waitlist_signups (...) VALUES (?, ?, ?, ?, ?, ?)
    //   ON CONFLICT(email) DO UPDATE SET claimed_handle = excluded.claimed_handle,
    //     handle_claimed_at = excluded.handle_claimed_at
    //     WHERE waitlist_signups.claimed_handle IS NULL
    //   RETURNING claimed_handle
    if (
      sql.startsWith("insert into waitlist_signups") &&
      sql.includes("on conflict(email) do update set") &&
      sql.includes("claimed_handle = excluded.claimed_handle")
    ) {
      const email = args[0] as string;
      const createdAt = args[1] as number;
      // args[2] = ip, args[3] = userAgent
      const handle = args[4] as string;
      const at = args[5] as number;
      // Enforce partial-unique index — another email cannot hold the
      // same handle. This is what makes the dup-handle test green.
      const conflict = [...waitlistStore.values()].find(
        (r) => r.claimed_handle === handle
      );
      if (conflict) {
        throw new Error(
          "duplicate key value violates unique constraint uniq_waitlist_claimed_handle"
        );
      }
      const existing = waitlistStore.get(email);
      if (!existing) {
        // INSERT branch — fresh row, claim succeeds.
        waitlistStore.set(email, {
          email,
          created_at: createdAt,
          claimed_handle: handle,
          handle_claimed_at: at,
          handle_object_id: null,
          handle_bound_user_id: null,
          handle_bound_at: null,
        });
        return {
          rows: [{ claimed_handle: handle }],
          rowsAffected: 1,
        };
      }
      // CONFLICT branch — only flip if claimed_handle is currently NULL.
      if (existing.claimed_handle !== null) {
        return { rows: [], rowsAffected: 0 };
      }
      existing.claimed_handle = handle;
      existing.handle_claimed_at = at;
      return {
        rows: [{ claimed_handle: handle }],
        rowsAffected: 1,
      };
    }

    // UPDATE waitlist_signups SET claimed_handle = NULL, handle_claimed_at = NULL WHERE email = ?
    if (
      sql.startsWith(
        "update waitlist_signups set claimed_handle = null, handle_claimed_at = null where email = ?"
      )
    ) {
      const email = args[0] as string;
      const row = waitlistStore.get(email);
      if (row) {
        row.claimed_handle = null;
        row.handle_claimed_at = null;
      }
      return { rows: [], rowsAffected: row ? 1 : 0 };
    }

    // UPDATE waitlist_signups SET handle_object_id = COALESCE(...), handle_bound_user_id = ?, handle_bound_at = ? WHERE email = ?
    if (
      sql.startsWith(
        "update waitlist_signups set handle_object_id = coalesce(handle_object_id, ?), handle_bound_user_id = ?, handle_bound_at = ? where email = ?"
      )
    ) {
      const nftId = args[0] as string | null;
      const userId = args[1] as string;
      const at = args[2] as number;
      const email = args[3] as string;
      const row = waitlistStore.get(email);
      if (row) {
        row.handle_object_id = row.handle_object_id ?? nftId;
        row.handle_bound_user_id = userId;
        row.handle_bound_at = at;
      }
      return { rows: [], rowsAffected: row ? 1 : 0 };
    }

    return { rows: [], rowsAffected: 0 };
  };

  return {
    ensureSchema: async () => {},
    db: () => ({ execute }),
    // userById uses db().execute() under the hood, but the route
    // imports it explicitly — implement it directly to keep the mock
    // surface minimal and predictable.
    userById: async (id: number) => usersStore.get(id) ?? null,
  };
});

// SuiNS resolver + operator. `mintSubname` is the function we toggle
// per-test (happy path vs. mint failure).
const mintSubnameMock = vi.fn();
vi.mock("@/lib/suins-operator", () => ({
  suins: () => ({
    getNameRecord: async () => {
      throw new Error("does not exist");
    },
  }),
  mintSubname: (...args: unknown[]) => mintSubnameMock(...args),
  suinsOperatorEnabled: () => true,
  assertOperatorGas: async () => {},
  LowOperatorGasError: class LowOperatorGasError extends Error {},
  OPERATOR_GAS_BLOCK_SUI: 0.02,
  OPERATOR_GAS_WARN_SUI: 0.05,
}));

// Email send — no-op success.
vi.mock("@/lib/email", () => ({
  // The claim route now pre-renders the email concurrently with the mint
  // and sends the prepared payload after; stub both halves (+ the legacy
  // one-shot helper) so the route's email calls resolve in tests.
  prerenderWaitlistConfirmation: vi.fn(async () => ({
    html: "<p>noop</p>",
    subject: "noop",
    to: "noop@talise.sui",
  })),
  sendPrerenderedWaitlistConfirmation: vi.fn(async () => ({ ok: true, id: "noop" })),
  sendWaitlistConfirmation: vi.fn(async () => ({ ok: true, id: "noop" })),
}));

// Rate-limit — always allow during tests.
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true, remaining: 100 }),
  rateLimitAsync: async () => ({ ok: true, remaining: 100 }),
  getClientIp: () => "127.0.0.1",
}));

beforeEach(() => {
  reset();
  currentSessionUserId = null;
  mintSubnameMock.mockReset();
  mintSubnameMock.mockResolvedValue({
    digest: "0xdeadbeef",
    subnameNftId: "0xabc",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 1. Normalizer ────────────────────────────────────────────────────────

describe("normalizeWaitlistHandle", () => {
  it("accepts simple lowercase labels", async () => {
    const { normalizeWaitlistHandle } = await import("@/lib/handle-claim");
    expect(normalizeWaitlistHandle("alice")).toEqual({ ok: true, handle: "alice" });
    expect(normalizeWaitlistHandle("AliCe")).toEqual({ ok: true, handle: "alice" });
    expect(normalizeWaitlistHandle("  bob ")).toEqual({ ok: true, handle: "bob" });
    // MIN_LEN is 3 — two-char labels are reserved, so the shortest
    // claimable handle is three chars.
    expect(normalizeWaitlistHandle("a1")).toEqual({
      ok: false,
      reason: "too_short",
    });
    expect(normalizeWaitlistHandle("ab1")).toEqual({ ok: true, handle: "ab1" });
    expect(normalizeWaitlistHandle("a-b-c")).toEqual({ ok: true, handle: "a-b-c" });
  });

  it("strips paste-formats", async () => {
    const { normalizeWaitlistHandle } = await import("@/lib/handle-claim");
    expect(normalizeWaitlistHandle("@alice")).toEqual({ ok: true, handle: "alice" });
    expect(normalizeWaitlistHandle("alice@talise")).toEqual({
      ok: true,
      handle: "alice",
    });
    expect(normalizeWaitlistHandle("alice@talise.sui")).toEqual({
      ok: true,
      handle: "alice",
    });
    expect(normalizeWaitlistHandle("alice.talise.sui")).toEqual({
      ok: true,
      handle: "alice",
    });
  });

  it("rejects bad charsets and lengths", async () => {
    const { normalizeWaitlistHandle } = await import("@/lib/handle-claim");
    expect(normalizeWaitlistHandle("")).toMatchObject({ ok: false });
    expect(normalizeWaitlistHandle("a")).toMatchObject({ ok: false, reason: "too_short" });
    expect(normalizeWaitlistHandle("a".repeat(33))).toMatchObject({
      ok: false,
      reason: "too_long",
    });
    expect(normalizeWaitlistHandle("-leading")).toMatchObject({
      ok: false,
      reason: "charset",
    });
    expect(normalizeWaitlistHandle("trailing-")).toMatchObject({
      ok: false,
      reason: "charset",
    });
    expect(normalizeWaitlistHandle("dou--ble")).toMatchObject({
      ok: false,
      reason: "charset",
    });
    expect(normalizeWaitlistHandle("has_underscore")).toMatchObject({
      ok: false,
      reason: "charset",
    });
    expect(normalizeWaitlistHandle("emoji-")).toMatchObject({
      ok: false,
      reason: "charset",
    });
    expect(normalizeWaitlistHandle("with space")).toMatchObject({
      ok: false,
      reason: "charset",
    });
  });

  it("rejects reserved names", async () => {
    const { normalizeWaitlistHandle } = await import("@/lib/handle-claim");
    for (const name of [
      "admin",
      "talise",
      "support",
      "team",
      "root",
      "system",
      "null",
      "undefined",
      "noreply",
    ]) {
      expect(normalizeWaitlistHandle(name)).toMatchObject({
        ok: false,
        reason: "reserved",
      });
    }
  });
});

// ─── 2. Claim flow (happy path) ────────────────────────────────────────────

describe("claim flow", () => {
  it("signed-in user → mint + DB writes claimed_handle and handle_bound_user_id", async () => {
    const user = seedUser({ id: 42, email: "alice@example.com" });
    seedWaitlist("alice@example.com");
    currentSessionUserId = user.id;

    const { POST: availabilityPOST } = await import(
      "@/app/api/waitlist/handle/availability/route"
    );
    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    // Availability — handle is free.
    const availReq = new Request("http://x/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", handle: "alice" }),
    });
    const availRes = await availabilityPOST(availReq);
    expect(availRes.status).toBe(200);
    const availBody = (await availRes.json()) as { available?: boolean };
    expect(availBody.available).toBe(true);

    // Claim — succeeds. mintSubname should be invoked with the user's
    // Sui address.
    const claimRes = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", handle: "alice" }),
      })
    );
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as {
      ok?: boolean;
      handle?: string;
      mintDigest?: string;
      suiAddress?: string;
    };
    expect(claimBody.ok).toBe(true);
    expect(claimBody.handle).toBe("alice");
    expect(claimBody.mintDigest).toBe("0xdeadbeef");
    expect(claimBody.suiAddress).toBe(user.sui_address);

    expect(mintSubnameMock).toHaveBeenCalledTimes(1);
    expect(mintSubnameMock).toHaveBeenCalledWith({
      username: "alice",
      userAddress: user.sui_address,
    });

    // Row reflects state — BOTH claimed_handle and the bind columns.
    const row = waitlistStore.get("alice@example.com");
    expect(row?.claimed_handle).toBe("alice");
    expect(row?.handle_bound_user_id).toBe(String(user.id));
    expect(row?.handle_object_id).toBe("0xabc");
    expect(typeof row?.handle_bound_at).toBe("number");

    // Users table updated with the canonical handle.
    expect(usersStore.get(user.id)?.talise_username).toBe("alice");

    // Second availability check on the same handle for a different user
    // now reports it as taken in DB.
    seedWaitlist("bob@example.com");
    const avail2 = await availabilityPOST(
      new Request("http://x/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com", handle: "alice" }),
      })
    );
    const avail2Body = (await avail2.json()) as {
      available?: boolean;
      reason?: string;
    };
    expect(avail2Body.available).toBe(false);
    expect(avail2Body.reason).toBe("taken_db");
  });
});

// ─── 3. Dup handle race ───────────────────────────────────────────────────

describe("dup handle race", () => {
  it("two signed-in emails racing for the same handle: first wins, second 409s", async () => {
    const u1 = seedUser({ id: 1, email: "first@example.com" });
    const u2 = seedUser({ id: 2, email: "second@example.com" });
    seedWaitlist("first@example.com");
    seedWaitlist("second@example.com");

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    // First claim wins outright.
    currentSessionUserId = u1.id;
    const resA = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "first@example.com", handle: "sele" }),
      })
    );
    expect(resA.status).toBe(200);

    // Second claim races and loses. The mocked partial-unique index
    // on `claimed_handle` raises a duplicate-key error which the route
    // translates to a 409.
    currentSessionUserId = u2.id;
    const resB = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "second@example.com", handle: "sele" }),
      })
    );
    expect(resB.status).toBe(409);
    const bodyB = (await resB.json()) as { error?: string };
    expect(bodyB.error).toMatch(/taken|claimed/i);

    // Store state: only the first email holds the handle.
    expect(waitlistStore.get("first@example.com")?.claimed_handle).toBe("sele");
    expect(waitlistStore.get("second@example.com")?.claimed_handle).toBe(null);
  });
});

// ─── 3b. One-name-per-user gate ───────────────────────────────────────────

describe("one-name-per-user gate", () => {
  it("user with users.talise_username already set → 409 alreadyClaimed, no mint", async () => {
    const user = seedUser({ id: 50, email: "owner@example.com" });
    user.talise_username = "owned"; // pre-existing name (prior claim / SuiNS)
    currentSessionUserId = user.id;

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const res = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "different" }),
      })
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error?: string;
      alreadyClaimed?: boolean;
      handle?: string;
    };
    expect(body.alreadyClaimed).toBe(true);
    expect(body.handle).toBe("owned");
    expect(body.error).toMatch(/@owned/);

    // No second mint, name unchanged.
    expect(mintSubnameMock).not.toHaveBeenCalled();
    expect(usersStore.get(user.id)?.talise_username).toBe("owned");
  });

  it("user with waitlist_signups.claimed_handle already set → 409 alreadyClaimed, no mint", async () => {
    const user = seedUser({ id: 51, email: "claimed@example.com" });
    seedWaitlist("claimed@example.com");
    // Email-row reservation present but users.talise_username still null
    // (a legacy claim that never backfilled the user row).
    waitlistStore.get("claimed@example.com")!.claimed_handle = "legacy";
    currentSessionUserId = user.id;

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const res = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "newname" }),
      })
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      alreadyClaimed?: boolean;
      handle?: string;
    };
    expect(body.alreadyClaimed).toBe(true);
    expect(body.handle).toBe("legacy");
    expect(mintSubnameMock).not.toHaveBeenCalled();
  });

  it("fresh claim writes BOTH claimed_handle AND talise_username", async () => {
    const user = seedUser({ id: 52, email: "fresh@example.com" });
    seedWaitlist("fresh@example.com");
    currentSessionUserId = user.id;

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const res = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "freshie" }),
      })
    );
    expect(res.status).toBe(200);
    expect(mintSubnameMock).toHaveBeenCalledTimes(1);
    expect(waitlistStore.get("fresh@example.com")?.claimed_handle).toBe(
      "freshie"
    );
    expect(usersStore.get(user.id)?.talise_username).toBe("freshie");
  });
});

// ─── 3c. Same-user double claim loses on the NULL-guarded user row ─────────

describe("same-user double claim", () => {
  it("second claim by the same user after a name lands → 409, no second mint", async () => {
    const user = seedUser({ id: 60, email: "dbl@example.com" });
    seedWaitlist("dbl@example.com");
    currentSessionUserId = user.id;

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const first = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "firstpick" }),
      })
    );
    expect(first.status).toBe(200);
    expect(mintSubnameMock).toHaveBeenCalledTimes(1);

    // Same user tries again with a different handle. The step-1 guard
    // (talise_username already set) blocks it; even if it slipped past,
    // the NULL-guarded user-row UPDATE would return zero rows. Exactly
    // one mint total.
    const second = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "secondpick" }),
      })
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { alreadyClaimed?: boolean };
    expect(body.alreadyClaimed).toBe(true);
    expect(mintSubnameMock).toHaveBeenCalledTimes(1); // still just one mint
    expect(usersStore.get(user.id)?.talise_username).toBe("firstpick");
  });
});

// ─── 4. Unauthenticated claim → 401 ───────────────────────────────────────

describe("unauthenticated claim", () => {
  it("returns 401 and never mints when there is no session", async () => {
    seedWaitlist("anon@example.com");
    // currentSessionUserId stays null.

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const res = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "anon@example.com", handle: "anon" }),
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/sign in/i);

    // No mint call, no DB write.
    expect(mintSubnameMock).not.toHaveBeenCalled();
    expect(waitlistStore.get("anon@example.com")?.claimed_handle).toBe(null);
  });

  it("ignores client-supplied email and uses the session email", async () => {
    // Google-first flow: the route derives the email from the session
    // cookie, NOT the request body. Any email the client sends is
    // ignored — no spoofing surface. The waitlist row is UPSERTed
    // against the session email, even if the user never hit the
    // legacy /api/waitlist endpoint.
    const u = seedUser({ id: 7, email: "real@example.com" });
    currentSessionUserId = u.id;

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const res = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "imposter@example.com",
          handle: "pwnd",
        }),
      })
    );
    expect(res.status).toBe(200);
    // Row was UPSERTed under the session email — not the imposter one.
    expect(waitlistStore.get("real@example.com")?.claimed_handle).toBe("pwnd");
    expect(waitlistStore.has("imposter@example.com")).toBe(false);
  });
});

// ─── 5. Mint failure → DB rollback ────────────────────────────────────────

describe("mint failure rollback", () => {
  it("rolls back claimed_handle to NULL when the on-chain mint throws", async () => {
    const user = seedUser({ id: 99, email: "retry@example.com" });
    seedWaitlist("retry@example.com");
    currentSessionUserId = user.id;

    mintSubnameMock.mockRejectedValueOnce(new Error("rpc disconnected"));

    const { POST: claimPOST } = await import(
      "@/app/api/waitlist/handle/claim/route"
    );

    const res = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "retry@example.com", handle: "retry" }),
      })
    );
    expect(res.status).toBe(502);

    // The DB row was reserved before the mint attempt; the rollback
    // path must wipe it so the user can retry.
    const row = waitlistStore.get("retry@example.com");
    expect(row?.claimed_handle).toBe(null);
    expect(row?.handle_claimed_at).toBe(null);
    expect(row?.handle_bound_user_id).toBe(null);
    expect(usersStore.get(user.id)?.talise_username).toBe(null);

    // Now the user retries with the same handle. mintSubnameMock is
    // back to the default success behavior — second attempt should
    // sail through.
    const res2 = await claimPOST(
      new Request("http://x/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "retry@example.com", handle: "retry" }),
      })
    );
    expect(res2.status).toBe(200);
    expect(waitlistStore.get("retry@example.com")?.claimed_handle).toBe(
      "retry"
    );
  });
});
