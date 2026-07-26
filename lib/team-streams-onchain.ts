import "server-only";

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { getNormalizedTransaction } from "@/lib/sui-shapes";

/**
 * On-chain team payroll streams, PTB builders for the
 * `talise_payroll_streams::team_stream` package. A stream's whole pot lives in a
 * creator-owned `TeamStream<USDSUI>` shared object, funded up front, with the
 * roster + schedule fixed at funding.
 *
 * `release_due_tranche` is PERMISSIONLESS on-chain: the contract itself guarantees
 * it can only pay the pre-set `per_member` share to each hardwired member, once the
 * Clock passes `next_due_ms`, at most `num_tranches` times. There is NO escrow key,
 * NO scheduler key and NO cron — the trigger is just an Onara-sponsored tx the
 * creator's app signs when it's open (anyone could sign it; they gain nothing).
 *
 * Mirrors `lib/automations.ts` (the standing-order builders) exactly: same coin
 * sourcing, same sponsor tail, same created-object-id parse.
 *
 * Gated by TEAM_STREAM_PACKAGE_ID + TEAM_STREAM_REGISTRY_ID (both required).
 * Unset → team streams are off and the routes 503.
 */

const SUI_CLOCK_ID = "0x6";
/** Fixed budget for create/cancel (one move call, same as rules/goals/streams). */
const GAS_BUDGET = 60_000_000n; // 0.06 SUI
/**
 * A release pays every member in ONE transaction (a coin per member), so the
 * budget has to scale with the roster. 60M base + 6M per member, which covers the
 * 50-member cap (~0.36 SUI ceiling) with a wide margin. Unused gas is refunded.
 */
function releaseGasBudget(memberCount: number): bigint {
  const n = BigInt(Math.max(1, Math.min(memberCount || 1, 50)));
  return GAS_BUDGET + n * 6_000_000n;
}

export function teamStreamPackageId(): string | null {
  return process.env.TEAM_STREAM_PACKAGE_ID?.trim() || null;
}
export function teamStreamRegistryId(): string | null {
  return process.env.TEAM_STREAM_REGISTRY_ID?.trim() || null;
}
export function teamStreamsOnchainEnabled(): boolean {
  return !!(teamStreamPackageId() && teamStreamRegistryId());
}

function requirePkgReg(): { pkg: string; reg: string } {
  const pkg = teamStreamPackageId();
  const reg = teamStreamRegistryId();
  if (!pkg || !reg) throw new Error("team streams not configured");
  return { pkg, reg };
}

/** Source a `Balance<USDSUI>` of `micros` from coins OR the accumulator (the
 *  create call wants a Balance). Mirrors lib/automations.ts::fundsBalance. */
async function fundsBalance(tx: Transaction, sender: string, micros: bigint) {
  let coinTotal = 0n;
  try {
    const res = await (sui() as unknown as {
      listCoins: (a: { owner: string; coinType: string }) => Promise<{ objects?: Array<{ balance?: string }> }>;
    }).listCoins({ owner: sender, coinType: USDSUI_TYPE });
    for (const o of res.objects ?? []) coinTotal += BigInt(o.balance ?? "0");
  } catch { /* fall through to accumulator */ }
  if (coinTotal >= micros) {
    return tx.moveCall({
      target: "0x2::coin::into_balance",
      typeArguments: [USDSUI_TYPE],
      arguments: [tx.add(coinWithBalance({ type: USDSUI_TYPE, balance: micros, useGasCoin: false }))],
    });
  }
  return tx.balance({ type: USDSUI_TYPE, balance: micros });
}

async function sponsorTail(tx: Transaction, gasBudget: bigint): Promise<{ bytes: string; sponsor: string }> {
  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onara().status(),
    sui().getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);
  tx.setGasOwner(sponsor);
  tx.setGasPrice(BigInt(gasPrice));
  tx.setGasBudget(gasBudget);
  const bytes = await tx.build({ client: sui() as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Onara-SPONSORED `team_stream::create`, the creator signs (becomes `creator`),
 * moving the ENTIRE pot (`totalMicros`) into the new shared stream object in that
 * one transaction. Nothing is held by Talise at any point, and there is no
 * separate "did the escrow get credited" verification to do: the funding IS the
 * create call, so a stream can only exist fully funded.
 *
 * Returns sponsor-ready bytes the client signs → /api/zk/sponsor-execute.
 */
export async function buildTeamStreamCreateSponsored(input: {
  sender: string;
  members: string[];
  numTranches: number;
  intervalMs: number;
  firstDueMs: number;
  totalMicros: bigint;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg, reg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  const funds = await fundsBalance(tx, input.sender, input.totalMicros);
  tx.moveCall({
    target: `${pkg}::team_stream::create`,
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(reg),
      funds,
      tx.pure.vector("address", input.members),
      tx.pure.u64(BigInt(input.numTranches)),
      tx.pure.u64(BigInt(input.intervalMs)),
      tx.pure.u64(BigInt(input.firstDueMs)),
    ],
  });
  return sponsorTail(tx, GAS_BUDGET);
}

/**
 * Onara-SPONSORED, PERMISSIONLESS `team_stream::release_due_tranche` — the trigger
 * for one due payroll tranche. The creator's app signs the sender slot when it's
 * open (anyone could, since the contract gates the release on the Clock + the
 * schedule, not on the caller). Returns sponsor-ready bytes the client signs →
 * /api/zk/sponsor-execute.
 *
 * The on-chain call aborts ENotDue if it isn't due yet, EExhausted once every
 * funded tranche is out, and ECancelled on a stopped stream — all harmless: the
 * client just skips. Firing the same tranche twice is IMPOSSIBLE (the second call
 * sees the advanced cursor), which is what replaces the old DB atomic claim.
 */
export async function buildReleaseDueTrancheSponsored(input: {
  sender: string;
  streamObjectId: string;
  memberCount: number;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg, reg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  tx.moveCall({
    target: `${pkg}::team_stream::release_due_tranche`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(reg), tx.object(input.streamObjectId), tx.object(SUI_CLOCK_ID)],
  });
  return sponsorTail(tx, releaseGasBudget(input.memberCount));
}

/**
 * Onara-SPONSORED `team_stream::cancel` (creator-signed): stops the stream and
 * refunds the ENTIRE remaining pot — unreleased tranches plus the rounding dust —
 * back to the creator in the same PTB. Also the post-completion dust sweep.
 */
export async function buildTeamStreamCancelSponsored(input: {
  sender: string;
  streamObjectId: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  const [refund] = tx.moveCall({
    target: `${pkg}::team_stream::cancel`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(input.streamObjectId)],
  });
  tx.transferObjects([refund], input.sender);
  return sponsorTail(tx, GAS_BUDGET);
}

/**
 * Parse the created TeamStream object id from a confirmed create tx digest.
 * Mirrors lib/automations.ts::parseCreatedOrderId (retries while the fullnode
 * catches up; returns null when the tx failed or the object isn't there).
 *
 * `expectedSender` is required on the money path: the digest is client-supplied,
 * so a stream is only ever attached to a row whose owner actually signed the
 * funding transaction. Fails CLOSED on a mismatch.
 */
export async function parseCreatedTeamStreamId(digest: string, expectedSender?: string): Promise<string | null> {
  const pkg = teamStreamPackageId();
  if (!pkg) return null;
  const prefix = `${pkg}::team_stream::TeamStream`.toLowerCase();
  const want = expectedSender?.trim().toLowerCase() || null;
  const DELAYS = [0, 800, 1200, 2000, 3000];
  for (let i = 0; i < DELAYS.length; i++) {
    if (DELAYS[i] > 0) await new Promise((r) => setTimeout(r, DELAYS[i]));
    let tx;
    try { tx = await getNormalizedTransaction(digest); } catch { continue; }
    if (tx.status !== "success") return null;
    if (want && tx.sender !== want) {
      console.warn(`[team-streams] create rejected: sender mismatch digest=${digest} sender=${tx.sender || "(none)"} expected=${want}`);
      return null;
    }
    for (const oc of tx.objectChanges) {
      if (oc.kind !== "created") continue;
      if ((oc.objectType ?? "").toLowerCase().startsWith(prefix)) return oc.objectId;
    }
    return null;
  }
  return null;
}

/**
 * Confirm a release transaction actually released a tranche on chain: the tx
 * succeeded, and it touched THIS stream object. The DB mirror is display-only and
 * the chain is authoritative, but the mirror should never advance on a digest that
 * isn't a real release for this stream. Fails CLOSED.
 */
export async function verifyStreamTxTouched(input: {
  digest: string;
  streamObjectId: string;
}): Promise<boolean> {
  try {
    const norm = await getNormalizedTransaction(input.digest);
    if (norm.status !== "success") return false;
    const want = input.streamObjectId.toLowerCase();
    return norm.objectChanges.some((oc) => (oc.objectId ?? "").toLowerCase() === want);
  } catch {
    return false; // fail CLOSED — the mirror simply doesn't advance
  }
}
