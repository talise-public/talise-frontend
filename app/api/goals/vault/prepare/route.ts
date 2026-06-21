import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";
import { getGoal } from "@/lib/rewards/goals";
import {
  goalVaultEnabled,
  appendCreateVaultWith,
  appendCreateVault,
  appendDepositToVault,
  appendWithdrawFromVault,
  appendVaultYieldStart,
  appendVaultYieldAdd,
  appendVaultYieldWithdraw,
} from "@/lib/goal-vault-ptb";

/** Yield (NAVI) goal ops are gated behind their own flag — the on-chain
 *  AccountCap-in-vault custody must be validated on a TestFlight build with a
 *  small real deposit before activation. Off → only plain vault ops. */
const GOAL_VAULT_YIELD_ENABLED =
  process.env.GOAL_VAULT_YIELD_ENABLED === "true";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generous fixed gas budget (0.06 SUI) — same rationale as sponsor-prepare:
// the sponsor's gas-coin selection must cover the budget; only actual gas is
// charged.
const SPONSOR_GAS_BUDGET_MIST = 60_000_000n;

/**
 * POST /api/goals/vault/prepare — build a sponsor-ready PTB that moves REAL
 * USDsui into / out of a goal's on-chain GoalVault (funds segregated from the
 * user's spendable balance — not the DB "tracking envelope").
 *
 * Body: { op: "create" | "deposit" | "withdraw", goalId, amountUsd?, name?, targetUsd? }
 * Returns base64 `bytes` the iOS app signs and forwards to /api/zk/sponsor-execute,
 * exactly like /api/send/sponsor-prepare. Gated on goalVaultEnabled() (the
 * goal_vault package id must be deployed + configured) → 503 otherwise, in
 * which case the app keeps using the DB tracking model.
 */
export async function POST(req: Request) {
  if (!goalVaultEnabled()) {
    return NextResponse.json(
      { error: "On-chain goal vaults aren't enabled yet.", code: "GOAL_VAULT_DISABLED" },
      { status: 503 }
    );
  }
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json({ error: "ONARA_URL not configured" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const rl = await rateLimitAsync({ key: `goal-vault:user:${userId}`, limit: 30, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { op?: string; goalId?: number; amountUsd?: number | string; name?: string; targetUsd?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const op = body.op;
  const PLAIN_OPS = ["create", "deposit", "withdraw"];
  const YIELD_OPS = ["yield-start", "yield-add", "yield-withdraw"];
  if (!PLAIN_OPS.includes(op ?? "") && !YIELD_OPS.includes(op ?? "")) {
    return NextResponse.json(
      { error: "op must be create|deposit|withdraw|yield-start|yield-add|yield-withdraw" },
      { status: 400 }
    );
  }
  if (YIELD_OPS.includes(op ?? "") && !GOAL_VAULT_YIELD_ENABLED) {
    return NextResponse.json(
      { error: "Goal yield isn't enabled yet.", code: "GOAL_YIELD_DISABLED" },
      { status: 503 }
    );
  }

  const amountUsd = Number(body.amountUsd);
  const goalId = Number(body.goalId);

  try {
    const onaraClient = onara();
    const client = sui();

    const sponsorPromise = memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status());
    const gasPricePromise = memoTtl(`sui:gas-price:goalvault`, 1_500, async () => {
      const r = await client.getReferenceGasPrice();
      return r.referenceGasPrice;
    });

    const tx = new Transaction();
    tx.setSender(user.sui_address);

    if (op === "create") {
      const name = String(body.name ?? "").trim().slice(0, 64);
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const targetUsd = Number(body.targetUsd) || 0;
      if (Number.isFinite(amountUsd) && amountUsd > 0) {
        appendCreateVaultWith(tx, { name, targetUsdsui: targetUsd, amountUsdsui: amountUsd });
      } else {
        appendCreateVault(tx, { name, targetUsdsui: targetUsd });
      }
    } else {
      // deposit / withdraw — resolve the vault id from the goal row server-side
      // (never trust a client-supplied object id), and require a positive amount.
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        return NextResponse.json({ error: "amountUsd must be positive" }, { status: 400 });
      }
      const goal = await getGoal(userId, goalId);
      if (!goal) return NextResponse.json({ error: "goal not found" }, { status: 404 });
      if (!goal.vaultObjectId) {
        return NextResponse.json(
          { error: "goal is not vault-backed yet", code: "GOAL_NOT_ON_CHAIN" },
          { status: 409 }
        );
      }
      if (op === "deposit") {
        appendDepositToVault(tx, { vaultId: goal.vaultObjectId, amountUsdsui: amountUsd });
      } else if (op === "withdraw") {
        appendWithdrawFromVault(tx, {
          vaultId: goal.vaultObjectId,
          amountUsdsui: amountUsd,
          owner: user.sui_address,
        });
      } else if (op === "yield-start") {
        // First time earning: mint cap, supply NEW funds to NAVI, park in vault.
        appendVaultYieldStart(tx, { vaultId: goal.vaultObjectId, amountUsdsui: amountUsd });
      } else if (op === "yield-add") {
        // Already earning: add more — basis becomes the goal's total + this add.
        appendVaultYieldAdd(tx, {
          vaultId: goal.vaultObjectId,
          amountUsdsui: amountUsd,
          totalBasisUsd: (goal.currentUsd ?? 0) + amountUsd,
        });
      } else {
        // yield-withdraw: redeem from NAVI back to vault principal; re-park.
        appendVaultYieldWithdraw(tx, {
          vaultId: goal.vaultObjectId,
          amountUsdsui: amountUsd,
          remainingBasisUsd: Math.max(0, (goal.currentUsd ?? 0) - amountUsd),
        });
      }
    }

    const [{ address: sponsor }, gasPrice] = await Promise.all([sponsorPromise, gasPricePromise]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));
    tx.setGasBudget(SPONSOR_GAS_BUDGET_MIST);
    const bytes = await tx.build({ client: client as never });

    return NextResponse.json({ bytes: toBase64(bytes), mode: "sponsored", op });
  } catch (err) {
    const msg = (err as Error).message ?? "build failed";
    console.warn(`[goals/vault/prepare] user=${userId} op=${op} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
