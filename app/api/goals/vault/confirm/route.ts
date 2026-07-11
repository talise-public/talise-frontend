import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { getNormalizedTransaction } from "@/lib/sui-shapes";
import { sui } from "@/lib/sui";
import { goalVaultEnabled, goalVaultPackageId } from "@/lib/goal-vault-ptb";
import { goalToWire } from "@/lib/rewards/goals";
import {
  getGoal,
  setGoalVaultObjectId,
  setGoalYieldOn,
  depositToGoal,
  withdrawFromGoal,
} from "@/lib/rewards/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/goals/vault/confirm — record an on-chain GoalVault op AFTER the
 * sponsored tx has landed.
 *
 * Body: { goalId, op: "create" | "deposit" | "withdraw", amountUsd, digest }
 *
 * The REAL funds live in the user's on-chain GoalVault (segregated from their
 * spendable balance). `current_usd` is only a DISPLAY tracker — so we sync it
 * here ONLY after verifying the tx (a) succeeded and (b) was sent by this user.
 * For `create` we also capture the freshly-minted GoalVault object id from the
 * tx's objectChanges (mirrors lib/cheques.ts) and persist it on the goal so
 * subsequent deposit/withdraw PTBs can target it.
 */
export async function POST(req: Request) {
  if (!goalVaultEnabled()) {
    return NextResponse.json(
      { error: "On-chain goal vaults aren't enabled yet.", code: "GOAL_VAULT_DISABLED" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { goalId?: number; op?: string; amountUsd?: number | string; digest?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const op = body.op;
  const goalId = Number(body.goalId);
  const amountUsd = Number(body.amountUsd);
  const digest = String(body.digest ?? "").trim();

  const RECORD_OPS = [
    "create",
    "deposit",
    "withdraw",
    "yield-start",
    "yield-add",
    "yield-withdraw",
  ];
  if (!RECORD_OPS.includes(op ?? "")) {
    return NextResponse.json(
      { error: "op must be create|deposit|withdraw|yield-start|yield-add|yield-withdraw" },
      { status: 400 }
    );
  }
  if (!digest) return NextResponse.json({ error: "digest required" }, { status: 400 });
  if (!Number.isFinite(goalId)) return NextResponse.json({ error: "goalId required" }, { status: 400 });
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    return NextResponse.json({ error: "amountUsd invalid" }, { status: 400 });
  }

  const goal = await getGoal(userId, goalId);
  if (!goal) return NextResponse.json({ error: "goal not found" }, { status: 404 });

  // Verify the on-chain tx: success + this user is the sender. We only sync the
  // display tracker AFTER this passes, so a failed/forged digest can't bump it.
  // The tx was JUST executed, so wait for it to index before reading (avoids a
  // false "tx lookup failed" race); the wait is best-effort.
  try {
    await sui().waitForTransaction({ digest });
  } catch {
    /* not indexed in time — try the read anyway below */
  }
  let tx;
  try {
    tx = await getNormalizedTransaction(digest);
  } catch (e) {
    return NextResponse.json({ error: `tx lookup failed: ${(e as Error).message}` }, { status: 502 });
  }
  if (tx.status !== "success") {
    return NextResponse.json(
      { error: `tx not successful: ${tx.errorMessage ?? "unknown"}` },
      { status: 409 }
    );
  }
  const sender = (tx.sender ?? "").toLowerCase();
  if (sender && sender !== user.sui_address.toLowerCase()) {
    return NextResponse.json({ error: "sender mismatch" }, { status: 403 });
  }

  try {
    if (op === "create") {
      // Capture the created GoalVault<T> object id from the tx.
      const pkg = goalVaultPackageId()!;
      const prefix = `${pkg}::goal_vault::goalvault<`.toLowerCase();
      let vaultId: string | null = goal.vaultObjectId ?? null;
      for (const ch of tx.objectChanges) {
        if (ch.kind !== "created") continue;
        const ty = (ch.objectType ?? "").toLowerCase();
        if (ty.startsWith(prefix) || ty.includes("::goal_vault::goalvault<")) {
          vaultId = ch.objectId;
          break;
        }
      }
      if (!vaultId) {
        return NextResponse.json({ error: "vault object not found in tx" }, { status: 409 });
      }
      await setGoalVaultObjectId(userId, goalId, vaultId);
      // If the create funded the vault (create_with), sync the display tracker.
      let updated = goal;
      if (amountUsd > 0) {
        updated = (await depositToGoal({ userId, goalId, amountUsd })).goal;
      } else {
        updated = (await getGoal(userId, goalId)) ?? goal;
      }
      return NextResponse.json({ goal: goalToWire(updated), vaultObjectId: vaultId });
    }

    // All remaining ops require an existing vault.
    if (!goal.vaultObjectId) {
      return NextResponse.json(
        { error: "goal not vault-backed", code: "GOAL_NOT_ON_CHAIN" },
        { status: 409 }
      );
    }

    // Yield ops move funds between the vault's principal and its NAVI position
    // WITHIN the same goal — the goal's total (current_usd) is unchanged. We
    // only flip the "earning" flag. (Display total stays put; APY accrues on
    // chain and is reflected when the position is next read.)
    if (op === "yield-start" || op === "yield-add" || op === "yield-withdraw") {
      const stillEarning =
        op === "yield-withdraw" ? amountUsd < goal.currentUsd - 1e-9 : true;
      await setGoalYieldOn(userId, goalId, stillEarning);
      const updated = (await getGoal(userId, goalId)) ?? goal;
      return NextResponse.json({ goal: goalToWire(updated) });
    }

    // deposit / withdraw (wallet ↔ vault principal).
    if (amountUsd <= 0) {
      return NextResponse.json({ error: "amountUsd must be positive" }, { status: 400 });
    }
    const updated =
      op === "deposit"
        ? (await depositToGoal({ userId, goalId, amountUsd })).goal
        : (await withdrawFromGoal({ userId, goalId, amountUsd })).goal;
    return NextResponse.json({ goal: goalToWire(updated) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? "record failed" }, { status: 500 });
  }
}
