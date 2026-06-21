import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";
import { shieldConfigured, SHIELD } from "@/lib/shield/onchain";
import { refreshMerkleCache } from "@/lib/shield/merkle";
import { appendShieldDeposit, type ShieldDepositProof } from "@/lib/shield/deposit-ptb";
import { jsonRpcResolutionPlugin } from "@/lib/shield/resolve";
import { USDSUI_TYPE } from "@/lib/usdsui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * In-app private send DEPOSIT leg. OFF BY DEFAULT. The native deposit-signing
 * bridge (webview proves → native zkLogin signs → Onara sponsors → withdraw via
 * relayer) is fund-safe at the protocol level (a deposited note self-encrypts
 * on-chain, so it's always recoverable by `scanNotes(viewingKey)`), but the
 * following GATES MUST be cleared before flipping this flag on a build that
 * touches real mainnet USDsui:
 *
 *   1. ONARA ALLOWLIST — the sponsorship policy must permit the `talise_privacy`
 *      package targets (`proof::new`, `ext_data::new`, `shielded_pool::transact`)
 *      or /api/zk/sponsor-execute rejects every deposit.
 *   2. SCAN-RESUME FLOW — if the app is torn down between a landed deposit and the
 *      withdraw, the in-memory output note is lost; funds are protocol-recoverable
 *      but a `scanNotes`-driven resume must exist to actually complete the queued
 *      transfer (otherwise the recipient never gets paid).
 *   3. DEVICE TEST — validate the full round-trip on TestFlight with a ≤$10 send.
 *
 * Off → the harness reports the honest "finalizing" status; funds are untouched.
 */
const SHIELD_INAPP_SEND_ENABLED = process.env.SHIELD_INAPP_SEND_ENABLED === "true";

// $10 per-tx cap (USDsui 6dp) — matches the on-chain pool max_deposit.
const MAX_DEPOSIT_MICROS = 10_000_000n;
// Same generous fixed gas budget as the other sponsored prepares (0.06 SUI).
const SPONSOR_GAS_BUDGET_MIST = 60_000_000n;

/**
 * POST /api/shield/deposit/prepare — build a sponsor-ready DEPOSIT PTB for the
 * in-app private send. The webview supplies the WASM-built Groth16 proof + the
 * two ECIES note blobs; this route sources the exact-$amount USDsui coin from the
 * USER's own balance, assembles the `transact` deposit PTB, wraps it with Onara
 * gas, and returns base64 `bytes` the iOS app zkLogin-signs and forwards to
 * /api/zk/sponsor-execute (exactly like /api/goals/vault/prepare).
 *
 * Body: {
 *   amountMicros: string,            // deposit value in micros (== proof public value)
 *   proof: { proofPointsHex, root, publicValue, inputNullifier0/1, outputCommitment0/1 },
 *   enc0B64: string, enc1B64: string // ECIES blobs for the two output notes
 * }
 * Returns { bytes, mode: "sponsored" } or a 503/4xx that fails closed.
 */
export async function POST(req: Request) {
  if (!shieldConfigured() || !SHIELD.packageId || !SHIELD.poolUsdsui) {
    return NextResponse.json(
      { error: "privacy not yet live", code: "SHIELD_OFF" },
      { status: 503 }
    );
  }
  if (!SHIELD_INAPP_SEND_ENABLED) {
    return NextResponse.json(
      { error: "In-app private send isn't enabled yet.", code: "SHIELD_INAPP_OFF" },
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
  const rl = await rateLimitAsync({ key: `shield-deposit:user:${userId}`, limit: 20, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: {
    amountMicros?: string | number;
    proof?: Partial<ShieldDepositProof>;
    enc0B64?: string;
    enc1B64?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // ── Validate amount + proof shape (fail closed) ────────────────────────────
  let amountMicros: bigint;
  try {
    amountMicros = BigInt(body.amountMicros ?? 0);
  } catch {
    return NextResponse.json({ error: "amountMicros must be an integer" }, { status: 400 });
  }
  if (amountMicros <= 0n) {
    return NextResponse.json({ error: "amountMicros must be positive" }, { status: 400 });
  }
  if (amountMicros > MAX_DEPOSIT_MICROS) {
    return NextResponse.json(
      { error: "Private sends are capped at $10 during the pilot.", code: "OVER_CAP" },
      { status: 400 }
    );
  }
  const pr = body.proof;
  if (
    !pr ||
    typeof pr.proofPointsHex !== "string" ||
    typeof pr.root !== "string" ||
    typeof pr.publicValue !== "string" ||
    typeof pr.inputNullifier0 !== "string" ||
    typeof pr.inputNullifier1 !== "string" ||
    typeof pr.outputCommitment0 !== "string" ||
    typeof pr.outputCommitment1 !== "string"
  ) {
    return NextResponse.json({ error: "malformed proof" }, { status: 400 });
  }
  // The cleartext value MUST equal the proof's public value (deposit: +amount).
  let provedValue: bigint;
  try {
    provedValue = BigInt(pr.publicValue);
  } catch {
    return NextResponse.json({ error: "proof.publicValue invalid" }, { status: 400 });
  }
  if (provedValue !== amountMicros) {
    return NextResponse.json(
      { error: "amount does not match the proof", code: "VALUE_MISMATCH" },
      { status: 400 }
    );
  }
  if (typeof body.enc0B64 !== "string" || typeof body.enc1B64 !== "string") {
    return NextResponse.json({ error: "missing encrypted outputs" }, { status: 400 });
  }
  let enc0: Uint8Array;
  let enc1: Uint8Array;
  try {
    enc0 = fromBase64(body.enc0B64);
    enc1 = fromBase64(body.enc1B64);
  } catch {
    return NextResponse.json({ error: "encrypted outputs must be base64" }, { status: 400 });
  }

  try {
    const onaraClient = onara();
    const client = sui();

    // Fail-fast UX: the proof root must be a CURRENTLY-KNOWN tree root, else the
    // on-chain assert_root_is_known rejects it. The indexer-rebuilt live root is
    // authoritative; a mismatch means the tree advanced — re-fetch + re-prove.
    const liveRoot = await refreshMerkleCache(USDSUI_TYPE);
    if (pr.root !== liveRoot) {
      return NextResponse.json(
        { error: "pool state advanced — retry", code: "ROOT_STALE", liveRoot },
        { status: 409 }
      );
    }

    const sponsorPromise = memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status());
    const gasPricePromise = memoTtl(`sui:gas-price:shield`, 1_500, async () => {
      const r = await client.getReferenceGasPrice();
      return r.referenceGasPrice;
    });

    const tx = new Transaction();
    tx.setSender(user.sui_address);
    appendShieldDeposit({
      tx,
      packageId: SHIELD.packageId,
      poolObjectId: SHIELD.poolUsdsui,
      coinType: USDSUI_TYPE,
      amountMicros,
      userAddress: user.sui_address,
      proof: pr as ShieldDepositProof,
      encryptedOutput0: enc0,
      encryptedOutput1: enc1,
    });

    const [{ address: sponsor }, gasPrice] = await Promise.all([sponsorPromise, gasPricePromise]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));
    tx.setGasBudget(SPONSOR_GAS_BUDGET_MIST);
    // Resolve the shared ShieldedPool object via JSON-RPC (same as the relay) —
    // the gRPC client mis-resolves shared objects (no initialSharedVersion). The
    // coinWithBalance plugin runs first + resolves the deposit coin, so this only
    // pins the pool.
    tx.addBuildPlugin(jsonRpcResolutionPlugin());
    const bytes = await tx.build({ client: client as never });

    return NextResponse.json({ bytes: toBase64(bytes), mode: "sponsored" });
  } catch (err) {
    const msg = (err as Error).message ?? "build failed";
    console.warn(`[shield/deposit/prepare] user=${userId} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
