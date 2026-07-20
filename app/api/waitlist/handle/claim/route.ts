import { NextResponse, after } from "next/server";
import { db, ensureSchema, userById } from "@/lib/db";
import {
  prerenderWaitlistConfirmation,
  sendPrerenderedWaitlistConfirmation,
} from "@/lib/email";
import {
  isWaitlistHandleAvailable,
  normalizeReasonMessage,
  normalizeWaitlistHandle,
} from "@/lib/handle-claim";
import { getClientIp, rateLimitAsync } from "@/lib/rate-limit";
import { readSessionEntryId } from "@/lib/session";
import { mintSubname, suinsOperatorEnabled, LowOperatorGasError } from "@/lib/suins-operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/waitlist/handle/claim
 *
 * Body: { handle: string }
 *
 * Auth-required: the caller MUST be signed in via the web session
 * cookie (the user clicked "Sign in with Google" on /waitlist BEFORE
 * picking a handle, the email used by the row is derived from the
 * authenticated session, not from the request body). On claim we:
 *   1. Resolve the user from the session cookie. No session → 401.
 *   2. ONE-NAME-PER-USER gate: if EITHER `users.talise_username` (by
 *      user.id) OR `waitlist_signups.claimed_handle` (by email) is
 *      already set, the user already owns a name → 409 alreadyClaimed.
 *   3. Confirm `<handle>.talise.sui` is free (DB + on-chain).
 *   4. Reserve `waitlist_signups.claimed_handle` (partial-unique index
 *      + NULL-guarded UPSERT; racers lose here).
 *   5. Reserve `users.talise_username` (NULL-guarded UPDATE ... RETURNING
 *      + global unique index; same-user racers and cross-user collisions
 *      lose here). BOTH reservations must succeed before any mint.
 *   6. Mint on chain via the Onara-sponsored operator PTB.
 *   7. Persist the NFT object id + bind the row to the user.
 *
 * If anything fails between step 4 and the mint, we ROLL BACK BOTH
 * reservations (claimed_handle → NULL, talise_username → NULL) so the
 * user can retry with the same handle and neither index permanently
 * locks the user (or everyone else) out. Crucially the user-row
 * reservation happens BEFORE the mint, so a user who already owns a
 * name can never mint a SECOND subname.
 */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  // Claim writes, tighter than availability. 6/min is well above any
  // human retry cadence.
  const rl = await rateLimitAsync({
    key: `waitlist-claim:${ip}`,
    limit: 6,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  let body: { handle?: unknown };
  try {
    body = (await req.json()) as { handle?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const norm = normalizeWaitlistHandle(body.handle);
  if (!norm.ok) {
    return NextResponse.json(
      { error: normalizeReasonMessage(norm.reason), reason: norm.reason },
      { status: 400 }
    );
  }

  // Auth gate. Google-first flow: the user signed in with Google
  // BEFORE picking a handle, so we always have a session here. The
  // email used for the waitlist row is derived from the session, not
  // accepted from the client, no spoofing surface.
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json(
      { error: "Sign in to claim." },
      { status: 401 }
    );
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json(
      { error: "Sign in to claim." },
      { status: 401 }
    );
  }
  const email = (user.email ?? "").trim().toLowerCase();
  if (!email) {
    return NextResponse.json(
      { error: "Your Google account has no email attached." },
      { status: 400 }
    );
  }

  try {
    await ensureSchema();
    const c = db();

    // ── One-name-per-USER gate (the critical fix) ──────────────────────
    //
    // BEFORE any availability check or reservation, block if THIS user
    // already has a name from EITHER source of truth:
    //
    //   • `users.talise_username` keyed by user.id, set by a prior
    //     claim, the sign-in bind hook, or a pre-existing SuiNS name
    //     reconciled onto the row out of band.
    //   • `waitlist_signups.claimed_handle` keyed by email, the legacy
    //     reservation column.
    //
    // Either being non-NULL means the user already owns a handle, so a
    // second on-chain mint must be impossible. We prefer the canonical
    // `users.talise_username` value when reporting back.
    const existingUserRow = await c.execute({
      sql: "SELECT talise_username FROM users WHERE id = ? LIMIT 1",
      args: [Number(user.id)],
    });
    const existingUsername = existingUserRow.rows[0]?.talise_username as
      | string
      | null
      | undefined;

    const emailRow = await c.execute({
      sql: "SELECT claimed_handle FROM waitlist_signups WHERE email = ? LIMIT 1",
      args: [email],
    });
    const prior = emailRow.rows[0]?.claimed_handle as
      | string
      | null
      | undefined;

    const alreadyHandle = existingUsername || prior;
    if (alreadyHandle) {
      return NextResponse.json(
        {
          error: `You already have @${alreadyHandle}.`,
          alreadyClaimed: true,
          handle: alreadyHandle,
        },
        { status: 409 }
      );
    }

    // Composite availability, DB + on-chain. Re-checked atomically
    // inside the UPDATE below, but failing fast here gives the user a
    // precise error instead of a generic "race lost" 409.
    const verdict = await isWaitlistHandleAvailable(norm.handle);
    if (!verdict.available) {
      return NextResponse.json(
        {
          error:
            verdict.reason === "taken_chain"
              ? "That handle is already minted on chain."
              : "That handle is taken.",
          reason: verdict.reason,
        },
        { status: 409 }
      );
    }

    // The DB reservation. Three guards make this safe:
    //  1. The UPSERT's WHERE in the conflict branch: only flip
    //     `claimed_handle` when the existing row's value is NULL -
    //     same email can't double-claim if two requests race.
    //  2. The partial-unique index on `claimed_handle`, two different
    //     emails racing for the same handle: one write wins, the
    //     other raises a unique-violation we catch as 409.
    //  3. In the Google-first flow the row may not exist yet, so we
    //     UPSERT: INSERT a fresh waitlist row when missing.
    //
    // We reserve BEFORE the mint so a concurrent racer can't sneak in
    // between our availability check and the on-chain submit. If the
    // mint subsequently fails we roll back this column to NULL so the
    // user (and others) can retry.
    const userAgent = req.headers.get("user-agent");
    let claimed = false;
    try {
      const upd = await c.execute({
        sql: `INSERT INTO waitlist_signups (
                 email, created_at, ip, user_agent,
                 claimed_handle, handle_claimed_at
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(email) DO UPDATE SET
                 claimed_handle = excluded.claimed_handle,
                 handle_claimed_at = excluded.handle_claimed_at
                 WHERE waitlist_signups.claimed_handle IS NULL
               RETURNING claimed_handle`,
        args: [
          email,
          Date.now(),
          ip,
          userAgent,
          norm.handle,
          Date.now(),
        ],
      });
      claimed = upd.rows.length > 0;
    } catch (e) {
      const msg = String((e as Error).message).toLowerCase();
      if (msg.includes("unique") || msg.includes("duplicate key")) {
        return NextResponse.json(
          { error: "Someone just claimed that handle. Pick another." },
          { status: 409 }
        );
      }
      throw e;
    }

    if (!claimed) {
      // The conflict branch's WHERE blocked the flip, `claimed_handle`
      // was already non-NULL when we tried to write. A same-email
      // double-claim race.
      return NextResponse.json(
        { error: "You already claimed a handle." },
        { status: 409 }
      );
    }

    // ── User-row reservation (authoritative, BEFORE the mint) ──────────
    //
    // Reserve `users.talise_username` with a conditional UPDATE that only
    // writes when the column is currently NULL, mirroring the
    // `claimed_handle` UPSERT pattern. `RETURNING id` confirms the write
    // landed:
    //   • zero rows  → the user already had a name (a racer set it, or
    //     the step-1 guard missed a write that landed in between) → 409,
    //     and we DO NOT mint. We first roll back the `claimed_handle`
    //     reservation we just took so the handle isn't orphaned.
    //   • UNIQUE violation → a DIFFERENT user already owns this exact
    //     `talise_username` (the global unique index fired) → treat as
    //     "taken", roll back `claimed_handle`, 409.
    //
    // Because BOTH the email-row reservation (claimed_handle) AND the
    // user-row reservation (talise_username) succeed before we ever call
    // mintSubname, no second mint can slip through: a second concurrent
    // claim for the same handle loses on the partial-unique
    // `claimed_handle` index, and a second claim by the SAME user loses
    // on the NULL-guarded user-row UPDATE.
    let userReserved = false;
    try {
      const ures = await c.execute({
        sql: `UPDATE users
                 SET talise_username = ?
               WHERE id = ?
                 AND talise_username IS NULL
               RETURNING id`,
        args: [norm.handle, Number(user.id)],
      });
      userReserved = ures.rows.length > 0;
    } catch (e) {
      const msg = String((e as Error).message).toLowerCase();
      if (msg.includes("unique") || msg.includes("duplicate key")) {
        // Some other user already owns this exact talise_username.
        await c
          .execute({
            sql: "UPDATE waitlist_signups SET claimed_handle = NULL, handle_claimed_at = NULL WHERE email = ?",
            args: [email],
          })
          .catch(() => null);
        return NextResponse.json(
          { error: "That handle is taken.", reason: "taken_db" },
          { status: 409 }
        );
      }
      // Unexpected DB error, roll back the handle reservation and bail.
      await c
        .execute({
          sql: "UPDATE waitlist_signups SET claimed_handle = NULL, handle_claimed_at = NULL WHERE email = ?",
          args: [email],
        })
        .catch(() => null);
      throw e;
    }

    if (!userReserved) {
      // The NULL guard blocked the write, this user already has a name.
      // Roll back the handle reservation we just took and surface the
      // already-claimed contract.
      await c
        .execute({
          sql: "UPDATE waitlist_signups SET claimed_handle = NULL, handle_claimed_at = NULL WHERE email = ?",
          args: [email],
        })
        .catch(() => null);
      const cur = await c
        .execute({
          sql: "SELECT talise_username FROM users WHERE id = ? LIMIT 1",
          args: [Number(user.id)],
        })
        .catch(() => null);
      const curHandle =
        (cur?.rows[0]?.talise_username as string | null | undefined) ?? null;
      return NextResponse.json(
        {
          error: curHandle ? `You already have @${curHandle}.` : "You already have a handle.",
          alreadyClaimed: true,
          handle: curHandle,
        },
        { status: 409 }
      );
    }

    // Both reservations now held. Helper to undo BOTH atomically-enough
    // for the single-writer flows we have, used on every failure path
    // below so a mid-flight error never leaves the user half-claimed or
    // permanently locked out.
    const rollbackBoth = async () => {
      await c
        .execute({
          sql: "UPDATE waitlist_signups SET claimed_handle = NULL, handle_claimed_at = NULL WHERE email = ?",
          args: [email],
        })
        .catch(() => null);
      await c
        .execute({
          sql: "UPDATE users SET talise_username = NULL WHERE id = ? AND talise_username = ?",
          args: [Number(user.id), norm.handle],
        })
        .catch(() => null);
    };

    // On-chain mint. Onara-sponsored, the user pays no gas, the
    // operator wallet covers it. We do this SYNCHRONOUSLY (within the
    // request lifecycle) so the response only resolves once the
    // subname truly exists on chain.
    if (!suinsOperatorEnabled()) {
      // Roll back BOTH reservations, we cannot honor the claim.
      await rollbackBoth();
      return NextResponse.json(
        {
          error:
            "Minting is temporarily unavailable. Please try again in a minute.",
        },
        { status: 503 }
      );
    }

    // Kick off the confirmation-email RENDER concurrently with the mint.
    // `render()` (React-Email → HTML) is pure, no network, no side
    // effects, so it is always safe to start here and lets the
    // (occasionally tens-of-ms) render overlap the slow on-chain mint
    // instead of running serially after it. Only the Resend API call is
    // left for the post-mint critical path, fired in `after()` below.
    //
    // We attach a no-op `.catch` so a render failure can never produce an
    // unhandled rejection while the mint is in flight; if the render did
    // fail we simply skip the email (logged in `after()`). This promise
    // is ONLY consumed on the success path after the mint resolves, it is
    // never sent on any error/rollback branch.
    const preparedEmailPromise = prerenderWaitlistConfirmation({
      to: email,
      name: user.name ?? null,
      claimedHandle: norm.handle,
    }).catch((e) => {
      console.warn(
        `[waitlist/handle/claim] confirmation email render failed email=${email} handle=${norm.handle}: ${(e as Error).message}`
      );
      return null;
    });

    let mintDigest = "";
    let mintNftId: string | null = null;
    try {
      const out = await mintSubname({
        username: norm.handle,
        userAddress: user.sui_address,
      });
      mintDigest = out.digest;
      mintNftId = out.subnameNftId;
    } catch (mintErr) {
      // Low operator gas: do NOT roll back. Keep both reservations so the user
      // KEEPS their name, it's reserved in the DB and the on-chain mint is
      // finalized later (the sign-in hook `bindWaitlistHandleIfAny` re-mints
      // reserved-but-unminted handles once gas is topped up). Return a calm
      // 503, not a scary failure.
      if (mintErr instanceof LowOperatorGasError) {
        // Keep the handle reserved (waitlist_signups.claimed_handle, with
        // handle_bound_user_id still NULL) but CLEAR the user-row reservation,
        // so bindWaitlistHandleIfAny's recovery query is no longer
        // short-circuited and re-mints the name on the user's next sign-in once
        // the operator is topped up. Without this the name is stranded forever.
        await c
          .execute({
            sql: "UPDATE users SET talise_username = NULL WHERE id = ? AND talise_username = ?",
            args: [Number(user.id), norm.handle],
          })
          .catch(() => null);
        console.error(
          `[waitlist/handle/claim] RESERVED (gas low) email=${email} handle=${norm.handle}, name held, mint queued for next sign-in`
        );
        return NextResponse.json(
          {
            ok: true,
            reserved: true,
            handle: norm.handle,
            message: `@${norm.handle} is reserved for you, we're finalizing it on-chain and it'll be live in a few minutes.`,
          },
          { status: 503 }
        );
      }
      // Any other mint failure: roll back BOTH reservations so the user (or
      // someone else) can retry. Surface a generic 502, the caller can't do
      // anything useful with the on-chain failure detail.
      const msg = (mintErr as Error).message.slice(0, 200);
      console.warn(
        `[waitlist/handle/claim] mint failed email=${email} handle=${norm.handle}: ${msg}`
      );
      await rollbackBoth();
      return NextResponse.json(
        { error: "On-chain mint failed. Try again." },
        { status: 502 }
      );
    }

    // Mint succeeded. Persist the bind on the waitlist row so the
    // sign-in hook (`bindWaitlistHandleIfAny`) treats it as already
    // bound on future logins, same hook is still wired for legacy
    // rows that pre-date this commit.
    await c.execute({
      sql: `UPDATE waitlist_signups
               SET handle_object_id = COALESCE(handle_object_id, ?),
                   handle_bound_user_id = ?,
                   handle_bound_at = ?
             WHERE email = ?`,
      args: [mintNftId, String(user.id), Date.now(), email],
    });

    // NOTE: `users.talise_username` was already reserved (conditional on
    // NULL, RETURNING-confirmed) BEFORE the mint above. There is nothing
    // left to write here, the mint can only have happened because that
    // reservation succeeded, so the user row is already authoritative.

    // Confirmation email, runs AFTER the response is returned, via
    // Next.js 15's `after()` hook. The old fire-and-forget pattern
    // (`withTimeout(...).catch(() => null)` without await) was racy
    // on Vercel: the serverless function instance can shut down
    // immediately after the response, killing any in-flight promise.
    // `after()` is the Vercel-aware equivalent, guarantees the work
    // finishes before the instance is reclaimed. No timeout cap, so
    // Resend cold-starts (occasionally 3–5s) still complete instead
    // of dropping the email silently. Errors are logged but never
    // surface to the user, who has already seen "your handle is
    // claimed."
    //
    // The HTML was already rendered concurrently with the mint above, so
    // by the time we get here `preparedEmailPromise` has almost always
    // resolved, `after()` does only the Resend API call, nothing else.
    after(async () => {
      try {
        const prepared = await preparedEmailPromise;
        if (!prepared) return; // render failed earlier (already logged)
        await sendPrerenderedWaitlistConfirmation(prepared);
      } catch (e) {
        console.warn(
          `[waitlist/handle/claim] confirmation email failed email=${email} handle=${norm.handle}: ${(e as Error).message}`
        );
      }
    });

    console.log(
      `[waitlist/handle/claim] minted email=${email} handle=${norm.handle} digest=${mintDigest} nft=${mintNftId ?? "?"}`
    );
    return NextResponse.json({
      ok: true,
      handle: norm.handle,
      mintDigest,
      suiAddress: user.sui_address,
    });
  } catch (err) {
    console.warn(
      "[waitlist/handle/claim] failed:",
      (err as Error).message,
      "email_len:",
      email.length
    );
    return NextResponse.json(
      { error: "Could not claim that handle. Try again." },
      { status: 500 }
    );
  }
}
