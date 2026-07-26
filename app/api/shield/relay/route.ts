import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { onara } from "@/lib/onara";
import { screenTransfer } from "@/lib/screening";
import { sui } from "@/lib/sui";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import {
  shieldConfigured,
  shieldRelayerAddress,
  shieldRelayerKeypair,
} from "@/lib/shield/relayer-config";
import {
  validateTransactCommands,
  ShieldValidationError,
} from "@/lib/shield/validate-commands";
import { jsonRpcResolutionPlugin } from "@/lib/shield/resolve";
import { shieldMaintenance } from "@/lib/shield/onchain";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-f0-9]{1,64}$/i;

/**
 * POST /api/shield/relay  { txBytes, exitAddress? }
 *
 * The relayer half of the shielded pool (Workstream C). Mirrors the
 * gate→screen→limit→sponsor flow of `/api/send/sponsor-prepare`, but for a
 * shielded `transact` PTB the CLIENT built (proof generated client-side; the
 * relayer is a gas sponsor + submitter only, NEVER a witness-holder):
 *
 *   1. Gate   , denyUnlessAppApproved + per-user rate limit (anti-abuse).
 *   2. Screen , screenTransfer on the exit (withdraw) address. ExtData
 *                 carries no recipient by design, so a WITHDRAW must declare
 *                 its exit address here for the compliance screen; an internal
 *                 transfer / deposit has no exit address and skips it.
 *   3. Validate, THE security control: `validateTransactCommands` asserts the
 *                 PTB is exactly a pinned `shielded_pool::transact[_with_account]`
 *                 shape and that ExtData.relayer == ours + fee <= MAX. Reject =>
 *                 400, bytes NEVER forwarded.
 *   4. Sponsor, set sender = relayer, relayer signs, Onara sponsors gas +
 *                 executes.
 *
 * 503 when the relayer is not configured.
 */
export async function POST(req: Request) {
  if (shieldMaintenance()) {
    return NextResponse.json(
      { error: "Private sends are currently in maintenance.", code: "SHIELD_MAINTENANCE" },
      { status: 503 }
    );
  }
  if (!shieldConfigured()) {
    return NextResponse.json(
      { error: "shield relayer not configured" },
      { status: 503 }
    );
  }
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json(
      { error: "ONARA_URL not configured" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // Gate reads concurrently (allowlist → rate-limit → user-row), same
  // precedence as sponsor-prepare.
  const [denied, rl, user] = await Promise.all([
    denyUnlessAppApproved(userId),
    rateLimitAsync({
      key: `shield-relay:user:${userId}`,
      limit: 30,
      windowSec: 3600,
    }),
    userById(userId),
  ]);
  if (denied) return denied;
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { txBytes?: string; exitAddress?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const txBytes = (body.txBytes ?? "").trim();
  if (!txBytes) {
    return NextResponse.json({ error: "txBytes required" }, { status: 400 });
  }

  // ── Compliance screen on the exit address (withdraw leg) ──────────────────
  // ExtData has no on-chain recipient field; the relayer screens the declared
  // exit address off-chain before sponsoring. For internal transfers / deposits
  // there is no exit, so `exitAddress` is omitted and the screen is skipped.
  const exitAddress = (body.exitAddress ?? "").trim().toLowerCase();
  if (exitAddress) {
    if (!ADDRESS_RE.test(exitAddress)) {
      return NextResponse.json(
        { error: "exitAddress must be a 0x-prefixed Sui address" },
        { status: 400 }
      );
    }
    const screen = await screenTransfer({
      senderAddr: user.sui_address,
      recipientAddr: exitAddress,
      senderName: user.business_name ?? user.name,
      recipientName: null,
    });
    if (!screen.allow) {
      console.warn(
        `[shield/relay] SCREENING_BLOCK user=${userId} exit=${exitAddress} cause=${screen.cause} reason=${screen.reason}`
      );
      return NextResponse.json(
        {
          error: "This withdrawal was blocked by a compliance screen.",
          code: "SCREENING_BLOCK",
          reason: screen.reason,
        },
        { status: 403 }
      );
    }
  }

  // ── THE security control, command allowlist ──────────────────────────────
  // Thread the already-screened exit address so the single allowed
  // TransferObjects (which delivers the transact RETURN coin) is pinned to it.
  // For deposit / internal-transfer legs there is no exit and the validator
  // requires the (zero) return coin to go to our own relayer address.
  try {
    validateTransactCommands(txBytes, { exitAddress: exitAddress || null });
  } catch (e) {
    if (e instanceof ShieldValidationError) {
      console.warn(`[shield/relay] REJECTED user=${userId}: ${e.message}`);
      return NextResponse.json(
        { error: "rejected by relayer command allowlist", code: "INVALID_PTB", reason: e.message },
        { status: 400 }
      );
    }
    throw e;
  }

  // ── Sponsor + execute via Onara ───────────────────────────────────────────
  // The relayer is the named `ExtData.relayer`, so it MUST be the tx `sender`
  // (the on-chain `ext_data::assert_relayer` checks `sender == relayer`). Onara
  // owns the gas. We rebuild the tx from the validated bytes, set sender, sign
  // with the relayer key, and hand the signed bytes to Onara.
  try {
    const relayer = shieldRelayerAddress()!;
    const signer = shieldRelayerKeypair();
    const onaraClient = onara();
    const client = sui();

    const [{ address: sponsor }, gasRes] = await Promise.all([
      onaraClient.status(),
      client.getReferenceGasPrice(),
    ]);
    const gasPrice = gasRes.referenceGasPrice;

    const tx = Transaction.from(txBytes);
    tx.setSender(relayer);
    tx.setGasOwner(sponsor);
    // Explicit gas price + a generous fixed budget (0.06 SUI), mirroring
    // /api/send/sponsor-prepare and goal-vault, without these the sponsor's
    // gas-coin selection could pick a dust coin and fail with "Insufficient gas".
    tx.setGasPrice(BigInt(gasPrice));
    tx.setGasBudget(60_000_000n);
    // Resolve the shielded PTB's object inputs (shared pool + zero-coin source)
    // via JSON-RPC, the gRPC client mis-resolves the SHARED pool object, which
    // made every relayer withdraw throw at build (relayer never submitted →
    // recipient never paid). Same proven resolver the CLI lifecycle uses.
    tx.addBuildPlugin(jsonRpcResolutionPlugin());

    const built = await tx.build({ client: client as never });
    const { signature } = await signer.signTransaction(built);

    const result = await onaraClient.sponsor({
      sender: relayer,
      txBytes: toBase64(built),
      txSignature: signature,
    });

    // Onara returns the raw gRPC TransactionResult, a discriminated union where
    // the digest sits one level deep (`{ $kind, Transaction: { digest, ... } }`).
    // The shielded SDK's submitRelay expects a top-level `digest`, so extract it
    // here (mirrors /api/zk/sponsor-execute), a missing digest is a real failure,
    // never a fake success.
    const r = result as Record<string, unknown>;
    const kind = r.$kind as string | undefined;
    const failed = r.FailedTransaction as { digest?: string } | undefined;
    const okTx =
      (r.Transaction as { digest?: string } | undefined) ??
      (r.transaction as { digest?: string } | undefined);

    // CRITICAL: Onara returns HTTP 200 with a FailedTransaction (which STILL
    // carries a digest) when the withdraw ABORTS on-chain (e.g. a TOCTOU
    // root-rotation / concurrent nullifier spend that passed simulation but
    // failed at execution). NEVER report that as a delivered send, the
    // recipient was not paid and the input note must not be treated as consumed.
    if (kind === "FailedTransaction" || (failed && !okTx)) {
      const failDigest = failed?.digest ?? "";
      console.error(
        `[shield/relay] FAILED on-chain withdraw user=${userId} digest=${failDigest}`,
        JSON.stringify(failed ?? r)
      );
      return NextResponse.json(
        {
          error: "withdraw failed on chain (aborted), funds not delivered",
          code: "WITHDRAW_ABORTED",
          ...(failDigest ? { digest: failDigest } : {}),
        },
        { status: 502 }
      );
    }

    const digest = (r.digest as string | undefined) ?? okTx?.digest ?? "";
    if (!digest) {
      console.error(
        "[shield/relay] no digest in Onara response, shape:",
        JSON.stringify(Object.keys(r))
      );
      return NextResponse.json(
        { error: "relayer submitted but returned no digest", code: "NO_DIGEST" },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, digest, result });
  } catch (err) {
    const msg = (err as Error).message ?? "relay failed";
    console.warn(`[shield/relay] user=${userId} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
