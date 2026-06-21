import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import { db, userById } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * Lightweight, web-session-cookie-only "am I signed in?" probe used by
 * the waitlist UI to branch between the "needs sign-in" CTA and the
 * "claim now" form. Unlike `/api/me`, this never touches SuiNS or any
 * RPC — it must be sub-10ms so we can race it in parallel with the
 * "existing handle" lookup on mount.
 *
 * Bearer tokens are intentionally NOT honored here: the waitlist is a
 * web surface, the mobile app has its own flow. Reading bearers would
 * be a footgun if some embedded webview replayed a header.
 *
 * Shape:
 *   { signedIn: false }
 *   { signedIn: true, email, suiAddress, handle: string | null }
 */
export async function GET(_req: Request) {
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ signedIn: false });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ signedIn: false });
  }

  let handle = user.talise_username ?? null;

  // Reconciliation / backfill for pre-existing names.
  //
  // `users.talise_username` is the canonical source `/api/auth/me`
  // reports. It can lag reality for users who claimed (and minted) via
  // an older code path that only wrote the waitlist row, or whose row
  // was bound to this user out of band. When the user row has no handle
  // but a waitlist row for this email already holds a `claimed_handle`
  // (and a minted `handle_object_id`, i.e. it's truly on chain), we
  // backfill `users.talise_username` so the reverse-lookup paths report
  // it consistently. Guarded on `talise_username IS NULL` so we never
  // overwrite an existing name, and best-effort (a UNIQUE collision or
  // any error leaves the response unchanged rather than failing the
  // probe).
  if (!handle) {
    const email = (user.email ?? "").trim().toLowerCase();
    if (email) {
      try {
        const c = db();
        const wl = await c.execute({
          sql: `SELECT claimed_handle FROM waitlist_signups
                  WHERE email = ?
                    AND claimed_handle IS NOT NULL
                    AND handle_object_id IS NOT NULL
                  LIMIT 1`,
          args: [email],
        });
        const claimed = wl.rows[0]?.claimed_handle as string | undefined;
        if (claimed) {
          const upd = await c.execute({
            sql: `UPDATE users
                     SET talise_username = ?
                   WHERE id = ?
                     AND talise_username IS NULL
                   RETURNING talise_username`,
            args: [claimed, Number(user.id)],
          });
          // Use the value that actually landed; if the conditional
          // UPDATE wrote nothing (a concurrent write set it), re-read.
          handle =
            (upd.rows[0]?.talise_username as string | undefined) ?? claimed;
        }
      } catch (e) {
        console.warn(
          `[auth/me] talise_username backfill skipped for user=${user.id}: ${(e as Error).message}`
        );
      }
    }
  }

  return NextResponse.json({
    signedIn: true,
    email: user.email,
    suiAddress: user.sui_address,
    handle: handle ?? null,
  });
}
