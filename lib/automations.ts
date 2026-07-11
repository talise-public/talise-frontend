import "server-only";

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { getNormalizedTransaction } from "@/lib/sui-shapes";

/**
 * On-chain automations — PTB builders for the `talise_automations::standing_order`
 * package (the audited, NON-CUSTODIAL "rule"). A rule's pot lives in a user-owned
 * `StandingOrder<USDSUI>` shared object. The owner funds it (sponsored, user-signed),
 * tops up / cancels (user-signed), and triggers due releases via `execute_due`.
 *
 * `execute_due` is PERMISSIONLESS on-chain: the contract itself guarantees it can
 * only release the pre-set `amount_per` to the pre-set `recipient` once the Clock
 * passes `next_due_ms`. There is NO scheduler key and NO cron — the smart contract
 * is the guarantee, and the trigger is just an Onara-sponsored tx the owner's app
 * signs when it's open (anyone could trigger it; they gain nothing).
 *
 * Gated by AUTOMATIONS_PACKAGE_ID + AUTOMATIONS_REGISTRY_ID (both required).
 * Unset → automations are off and the routes 503.
 */

const SUI_CLOCK_ID = "0x6";
const GAS_BUDGET = 60_000_000n; // 0.06 SUI — same fixed budget streams/goal use.

export function automationsPackageId(): string | null {
  return process.env.AUTOMATIONS_PACKAGE_ID?.trim() || null;
}
export function automationsRegistryId(): string | null {
  return process.env.AUTOMATIONS_REGISTRY_ID?.trim() || null;
}
export function automationsEnabled(): boolean {
  return !!(automationsPackageId() && automationsRegistryId());
}

function requirePkgReg(): { pkg: string; reg: string } {
  const pkg = automationsPackageId();
  const reg = automationsRegistryId();
  if (!pkg || !reg) throw new Error("automations not configured");
  return { pkg, reg };
}

/** Source a `Balance<USDSUI>` of `micros` from coins OR the accumulator (the
 *  create call wants a Balance). Mirrors buildStreamCreateSponsored. */
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

async function sponsorTail(tx: Transaction): Promise<{ bytes: string; sponsor: string }> {
  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onara().status(),
    sui().getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);
  tx.setGasOwner(sponsor);
  tx.setGasPrice(BigInt(gasPrice));
  tx.setGasBudget(GAS_BUDGET);
  const bytes = await tx.build({ client: sui() as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Onara-SPONSORED `standing_order::create` — the user signs (becomes `owner`),
 * funding the pot with `prefundMicros` (>= amountPerMicros). Returns sponsor-ready
 * bytes the client signs → /api/zk/sponsor-execute.
 */
export async function buildCreateOrderSponsored(input: {
  sender: string;
  recipient: string;
  amountPerMicros: bigint;
  intervalMs: number;
  firstDueMs: number;
  prefundMicros: bigint;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg, reg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  const funds = await fundsBalance(tx, input.sender, input.prefundMicros);
  tx.moveCall({
    target: `${pkg}::standing_order::create`,
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(reg),
      funds,
      tx.pure.address(input.recipient),
      tx.pure.u64(input.amountPerMicros),
      tx.pure.u64(BigInt(input.intervalMs)),
      tx.pure.u64(BigInt(input.firstDueMs)),
    ],
  });
  return sponsorTail(tx);
}

/** Onara-SPONSORED `standing_order::top_up` (owner-signed). */
export async function buildTopUpSponsored(input: {
  sender: string;
  orderId: string;
  micros: bigint;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  const funds = await fundsBalance(tx, input.sender, input.micros);
  tx.moveCall({
    target: `${pkg}::standing_order::top_up`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(input.orderId), funds],
  });
  return sponsorTail(tx);
}

/**
 * Onara-SPONSORED `standing_order::cancel` (owner-signed) — stops the rule and
 * refunds the entire remaining pot to the owner (the Move call returns a Coin we
 * transfer back to the sender in the same PTB).
 */
export async function buildCancelOrderSponsored(input: {
  sender: string;
  orderId: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  const [refund] = tx.moveCall({
    target: `${pkg}::standing_order::cancel`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(input.orderId)],
  });
  tx.transferObjects([refund], input.sender);
  return sponsorTail(tx);
}

/**
 * Onara-SPONSORED, PERMISSIONLESS `standing_order::execute_due` — the trigger for
 * a due release. The owner's app signs the sender slot when it's open (anyone
 * could, since the contract gates the release on the Clock + schedule, not on the
 * caller). Returns sponsor-ready bytes the client signs → /api/zk/sponsor-execute.
 * The on-chain call aborts ENotDue if it isn't due yet (harmless — the client just
 * skips it) and EInsufficientPot if the pot is empty.
 */
export async function buildExecuteDueSponsored(input: {
  sender: string;
  orderId: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const { pkg, reg } = requirePkgReg();
  const tx = new Transaction();
  tx.setSender(input.sender);
  tx.moveCall({
    target: `${pkg}::standing_order::execute_due`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(reg), tx.object(input.orderId), tx.object(SUI_CLOCK_ID)],
  });
  return sponsorTail(tx);
}

/** Parse the created StandingOrder object id from a confirmed create tx digest. */
export async function parseCreatedOrderId(digest: string): Promise<string | null> {
  const pkg = automationsPackageId();
  if (!pkg) return null;
  const prefix = `${pkg}::standing_order::StandingOrder`.toLowerCase();
  const DELAYS = [0, 800, 1200, 2000, 3000];
  for (let i = 0; i < DELAYS.length; i++) {
    if (DELAYS[i] > 0) await new Promise((r) => setTimeout(r, DELAYS[i]));
    let tx;
    try { tx = await getNormalizedTransaction(digest); } catch { continue; }
    if (tx.status !== "success") return null;
    for (const oc of tx.objectChanges) {
      if (oc.kind !== "created") continue;
      if ((oc.objectType ?? "").toLowerCase().startsWith(prefix)) return oc.objectId;
    }
    return null;
  }
  return null;
}
