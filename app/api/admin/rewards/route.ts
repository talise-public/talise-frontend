import { NextResponse } from "next/server";
import { resolveAdminFromRequest, type AdminCtx } from "@/lib/admin-auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import {
  clawbackUser,
  fulfilRedemption,
  listFarmingFlags,
  listIntegrityAudit,
  setFarmingFlag,
  type ClawbackScope,
} from "@/lib/rewards/integrity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rewards integrity operations. The ONLY write path into the rewards
 * ledger that isn't driven by chain verification.
 *
 * `/api/admin/ledger` is read-only SELECTs, which left two gaps: a
 * farming inviter's points could not be reversed, and a `pending`
 * redemption could never be marked fulfilled (the row sat pending
 * forever with no record that the operator had shipped the perk).
 *
 * ── Gating ──────────────────────────────────────────────────────────
 *
 *   1. `resolveAdminFromRequest` — `x-admin-token` (constant-time
 *      compare), the `talise_admin` cookie, or an allowlisted Google
 *      session. `isDevOpen()` is hard-disabled on any Vercel deployment,
 *      so there is no open access in production.
 *   2. `via: "dev"` is REJECTED for every mutating action even locally.
 *      Reversing real balances should require a real credential, and a
 *      dev-open session has no identity to write into the audit trail.
 *   3. IP rate limit: 20 mutations / 5 min. An operator does a handful;
 *      a loop is either a mistake or an attack.
 *   4. Every mutation demands an explicit `reason` (>= 8 chars) and
 *      `confirmUserId` echoing the target, so a fat-fingered id can't
 *      wipe the wrong account's points.
 *   5. Every mutation lands a row in `rewards_integrity_audit` with the
 *      resolved actor. Nothing here edits a balance silently.
 *
 * GET  ?view=flags|audit      → current farming flags / audit trail
 * POST { action: "clawback",  userId, confirmUserId, reason, scope?, block?, dryRun?, idempotencyKey? }
 * POST { action: "unflag",    userId, confirmUserId, reason }
 * POST { action: "fulfil_redemption", redemptionId, userId, confirmUserId, reason }
 */

const MUTATION_LIMIT = { limit: 20, windowSec: 5 * 60 };
const MIN_REASON_LEN = 8;

function actorLabel(ctx: AdminCtx): string {
  if (ctx.via === "session") {
    return `session:${ctx.email ?? ctx.handle ?? "unknown"}`;
  }
  return ctx.via;
}

async function requireMutatingAdmin(
  req: Request
): Promise<{ ok: true; actor: string } | { ok: false; res: Response }> {
  const ctx = await resolveAdminFromRequest(req);
  if (!ctx) {
    return {
      ok: false,
      res: NextResponse.json({ error: "admin auth required" }, { status: 401 }),
    };
  }
  if (ctx.via === "dev") {
    // Local dev-open has no identity. Reversing points must be
    // attributable, so require a token or an allowlisted session.
    return {
      ok: false,
      res: NextResponse.json(
        {
          error:
            "dev-open admin cannot mutate rewards; set ADMIN_TOKEN and send x-admin-token",
        },
        { status: 403 }
      ),
    };
  }
  const rl = rateLimit({
    key: `admin-rewards:${getClientIp(req)}`,
    ...MUTATION_LIMIT,
  });
  if (!rl.ok) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "too many rewards mutations, slow down" },
        { status: 429 }
      ),
    };
  }
  return { ok: true, actor: actorLabel(ctx) };
}

export async function GET(req: Request) {
  const ctx = await resolveAdminFromRequest(req);
  if (!ctx) {
    return NextResponse.json({ error: "admin auth required" }, { status: 401 });
  }
  const view = new URL(req.url).searchParams.get("view") ?? "flags";
  if (view === "audit") {
    return NextResponse.json({ view, rows: await listIntegrityAudit(200) });
  }
  return NextResponse.json({ view: "flags", rows: await listFarmingFlags(200) });
}

export async function POST(req: Request) {
  const gate = await requireMutatingAdmin(req);
  if (!gate.ok) return gate.res;
  const actor = gate.actor;

  let body: {
    action?: unknown;
    userId?: unknown;
    confirmUserId?: unknown;
    redemptionId?: unknown;
    reason?: unknown;
    scope?: unknown;
    block?: unknown;
    dryRun?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const userId = Number(body.userId);
  const confirmUserId = Number(body.confirmUserId);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  if (confirmUserId !== userId) {
    return NextResponse.json(
      { error: "confirmUserId must echo userId" },
      { status: 400 }
    );
  }
  if (reason.length < MIN_REASON_LEN) {
    return NextResponse.json(
      { error: `reason required (>= ${MIN_REASON_LEN} chars)` },
      { status: 400 }
    );
  }

  try {
    if (action === "clawback") {
      const scope: ClawbackScope = body.scope === "all" ? "all" : "policy";
      const result = await clawbackUser({
        userId,
        scope,
        reason,
        actor,
        block: body.block !== false,
        dryRun: body.dryRun === true,
        idempotencyKey:
          typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0
            ? body.idempotencyKey.slice(0, 200)
            : undefined,
      });
      return NextResponse.json({ ok: true, action, result });
    }

    if (action === "unflag") {
      await setFarmingFlag({ userId, blocked: false, reason, actor });
      return NextResponse.json({ ok: true, action, userId });
    }

    if (action === "fulfil_redemption") {
      const redemptionId = Number(body.redemptionId);
      if (!Number.isInteger(redemptionId) || redemptionId <= 0) {
        return NextResponse.json(
          { error: "redemptionId required" },
          { status: 400 }
        );
      }
      // `expectUserId` makes the ownership check happen BEFORE the write,
      // so a mistyped id can't close out somebody else's redemption.
      const result = await fulfilRedemption({
        redemptionId,
        actor,
        reason,
        expectUserId: userId,
      });
      if (!result.ok) {
        return NextResponse.json(
          { error: result.reason ?? "fulfilment failed" },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true, action, result });
    }

    return NextResponse.json(
      { error: `unknown action: ${action}` },
      { status: 400 }
    );
  } catch (e) {
    console.error(`[admin/rewards] ${action} failed:`, (e as Error).message);
    return NextResponse.json(
      { error: "rewards mutation failed" },
      { status: 500 }
    );
  }
}
