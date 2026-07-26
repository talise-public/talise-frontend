import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { db, userById } from "@/lib/db";
import { findTaliseSubnameForOwner } from "@/lib/suins-lookup";
import { refreshInBackground } from "@/lib/snapshots";
import { refreshSessionCookie } from "@/lib/session";
import { usdWithdrawalAllowed } from "@/lib/offramp-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me, current user, shape matches the iOS UserDTO.
 *
 * This is on the iOS LAUNCH GATE: AppSession.bootstrap() awaits it before
 * the app reaches `.ready`. So it must be FAST. The handle is the only
 * field that ever needed the chain, and we already know it:
 *
 *   1. `users.talise_username`, the claimed handle, backfilled at claim
 *      time. When present we return it instantly (the subname is just
 *      `<handle>.talise.sui`), with NO RPC.
 *   2. `users.suins_subname`, a cached resolved subname for users who own
 *      an on-chain name but somehow lack `talise_username`.
 *   3. Only when neither is known do we pay the live reverse-SuiNS lookup
 *      (`findTaliseSubnameForOwner`, up to 4 listOwnedObjects pages + a
 *      getNameRecord), and we persist the result so it's never paid again.
 *
 * `?fresh=1` forces the live lookup (e.g. right after a handle claim) so a
 * just-minted name surfaces immediately.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // Slide the web session forward on activity (no-op for mobile Bearer auth).
  // The client polls /api/me, so an active user's session never idle-expires;
  // an idle one lapses and the next /api/me 401s → client auto-logs-out.
  await refreshSessionCookie();

  // Server-driven feature gates, flip these in Vercel (Project → Settings →
  // Environment Variables) to open a feature WITHOUT shipping a new build.
  // DEFAULT CLOSED: a feature is on only when its env var is exactly "true".
  // iOS hides the corresponding entry point when the flag is false.
  const features = {
    // Cash-out is OPEN by default (failed payouts auto-refund via refundAddress).
    // Close with FEATURE_CASHOUT=false. Scan-to-pay stays closed until opened.
    cashout: process.env.FEATURE_CASHOUT?.trim().toLowerCase() !== "false",
    scanToPay: process.env.FEATURE_SCAN_TO_PAY?.trim().toLowerCase() === "true",
    // US cash-out (Bridge). Per-user allowlist gate (USD_WITHDRAWAL_OPEN or the
    // allowlist envs), and always closed for Apple private-relay emails.
    usdWithdrawal: usdWithdrawalAllowed({
      email: user.email,
      talise_username: (user as { talise_username?: string | null }).talise_username ?? null,
    }),
  };

  const base = {
    id: String(user.id),
    email: user.email,
    name: user.name,
    picture: user.picture,
    pfpUrl: (user as { pfp_url?: string | null }).pfp_url ?? null,
    country: user.country,
    suiAddress: user.sui_address,
    accountType: user.account_type,
    businessName: user.business_name,
    businessHandle: user.business_handle,
    features,
  };

  const fresh = new URL(req.url).searchParams.get("fresh") === "1";

  // Fast path: handle is already known in Postgres, no RPC on the gate.
  if (!fresh) {
    const claimed = user.talise_username?.trim();
    if (claimed) {
      return NextResponse.json({
        ...base,
        taliseHandle: claimed,
        taliseSubname: `${claimed}.talise.sui`,
      });
    }
    const cached = user.suins_subname?.trim();
    if (cached) {
      return NextResponse.json({
        ...base,
        taliseHandle: cached.replace(/\.talise\.sui$/i, ""),
        taliseSubname: cached,
      });
    }
  }

  // Cold path (or ?fresh=1): live reverse-SuiNS lookup. Persist the result
  // so the gate is instant next time.
  const subname = await findTaliseSubnameForOwner(user.sui_address).catch(() => null);
  if (subname?.username) {
    const full = subname.fullName ?? `${subname.username}.talise.sui`;
    refreshInBackground(async () => {
      await db().execute({
        sql: `UPDATE users
                SET talise_username = COALESCE(talise_username, $1),
                    suins_subname = $2,
                    suins_subname_at = $3
              WHERE id = $4`,
        args: [subname.username, full, Date.now(), user.id],
      });
    });
  }

  return NextResponse.json({
    ...base,
    taliseHandle: subname?.username ?? null,
    taliseSubname: subname?.fullName ?? null,
  });
}
