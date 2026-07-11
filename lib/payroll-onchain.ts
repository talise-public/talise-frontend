import "server-only";

import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { getNormalizedTransaction } from "@/lib/sui-shapes";
import { resolveRecipient } from "@/lib/suins";
import type { PayoutTeamMember } from "@/lib/payout-teams";

/**
 * On-chain payroll TEAMS — server seam (mirrors lib/streams.ts).
 *
 * A team's ROSTER lives on-chain as a `talise_payroll::payroll::Team` shared
 * object: create/edit/delete are Onara-sponsored Move calls the user signs.
 * The object holds NO money — paying the team still routes through the screened
 * `/api/payouts/batch/prepare` → `talise::batch_pay::pay_many` path, which
 * re-resolves + compliance-screens every recipient + checks send limits. This
 * file builds only the roster-mutation transactions + reads back the created
 * object id.
 *
 * Gated by `PAYROLL_PACKAGE_ID`: unset → `payrollOnchainEnabled()` is false and
 * the routes fall back to the plain DB upsert (exactly today's behaviour), so
 * nothing breaks before the package is published.
 */

export function payrollPackageId(): string | null {
  return process.env.PAYROLL_PACKAGE_ID ?? null;
}

export function payrollOnchainEnabled(): boolean {
  return !!process.env.PAYROLL_PACKAGE_ID;
}

/** Lowercased `0x<pkg>::payroll::Team` prefix used to spot the created object. */
function teamObjectTypePrefix(pkg: string): string {
  return `${pkg}::payroll::Team`.toLowerCase();
}

const GAS_BUDGET = 60_000_000n; // 0.06 SUI — same fixed budget streams/goal use.

/** USD float → 1e-6 micro units (clamped non-negative). */
function toMicros(amount: number | undefined): bigint {
  if (!Number.isFinite(amount) || (amount ?? 0) <= 0) return 0n;
  return BigInt(Math.round((amount as number) * 1_000_000));
}

export interface ResolvedRoster {
  addresses: string[];
  amountsMicro: bigint[];
  labels: string[];
}

/**
 * Resolve every member's typed recipient (@handle / name.talise.sui / 0x…) to
 * an address for the on-chain vectors. Throws a friendly Error naming the first
 * recipient that can't be resolved — the same failure the editor's live lookup
 * already surfaces, enforced server-side before we build the transaction.
 */
export async function resolveRoster(
  members: PayoutTeamMember[]
): Promise<ResolvedRoster> {
  const addresses: string[] = [];
  const amountsMicro: bigint[] = [];
  const labels: string[] = [];
  for (const m of members) {
    const r = await resolveRecipient(m.recipient);
    if (!r) {
      throw new Error(`Couldn't find anyone for "${m.recipient}".`);
    }
    addresses.push(r.address);
    amountsMicro.push(toMicros(m.amount));
    labels.push((m.label ?? "").slice(0, 120));
  }
  return { addresses, amountsMicro, labels };
}

/** Onara sponsor address + reference gas price (parallel), like streams. */
async function sponsorContext(): Promise<{ sponsor: string; gasPrice: bigint }> {
  const client = sui();
  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onara().status(),
    client.getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);
  return { sponsor, gasPrice: BigInt(gasPrice) };
}

function applySponsoredTail(tx: Transaction, sponsor: string, gasPrice: bigint) {
  tx.setGasOwner(sponsor);
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(GAS_BUDGET);
}

/**
 * Build the Onara-SPONSORED `payroll::create` PTB. The user signs the sender
 * slot (becomes the team's on-chain `owner`); Onara owns the gas. Returns
 * sponsor-ready base64 bytes for iOS to sign + POST to /api/zk/sponsor-execute.
 */
export async function buildTeamCreateSponsored(input: {
  senderAddress: string;
  name: string;
  roster: ResolvedRoster;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = payrollPackageId();
  if (!pkg) throw new Error("PAYROLL_PACKAGE_ID unset — on-chain teams disabled");
  const { sponsor, gasPrice } = await sponsorContext();

  const tx = new Transaction();
  tx.setSender(input.senderAddress);
  tx.moveCall({
    target: `${pkg}::payroll::create`,
    arguments: [
      tx.pure.string(input.name),
      tx.pure.vector("address", input.roster.addresses),
      tx.pure.vector("u64", input.roster.amountsMicro),
      tx.pure.vector("string", input.roster.labels),
    ],
  });
  applySponsoredTail(tx, sponsor, gasPrice);
  const bytes = await tx.build({ client: sui() as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Build the Onara-SPONSORED `payroll::set_roster` PTB — the edit path. The
 * contract asserts `ctx.sender() == team.owner`, so a non-owner's signed tx
 * aborts on chain.
 */
export async function buildTeamEditSponsored(input: {
  senderAddress: string;
  teamObjectId: string;
  name: string;
  roster: ResolvedRoster;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = payrollPackageId();
  if (!pkg) throw new Error("PAYROLL_PACKAGE_ID unset — on-chain teams disabled");
  const { sponsor, gasPrice } = await sponsorContext();

  const tx = new Transaction();
  tx.setSender(input.senderAddress);
  tx.moveCall({
    target: `${pkg}::payroll::set_roster`,
    arguments: [
      tx.object(input.teamObjectId),
      tx.pure.string(input.name),
      tx.pure.vector("address", input.roster.addresses),
      tx.pure.vector("u64", input.roster.amountsMicro),
      tx.pure.vector("string", input.roster.labels),
    ],
  });
  applySponsoredTail(tx, sponsor, gasPrice);
  const bytes = await tx.build({ client: sui() as never });
  return { bytes: toBase64(bytes), sponsor };
}

/** Build the Onara-SPONSORED `payroll::delete` PTB (owner-only on chain). */
export async function buildTeamDeleteSponsored(input: {
  senderAddress: string;
  teamObjectId: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = payrollPackageId();
  if (!pkg) throw new Error("PAYROLL_PACKAGE_ID unset — on-chain teams disabled");
  const { sponsor, gasPrice } = await sponsorContext();

  const tx = new Transaction();
  tx.setSender(input.senderAddress);
  tx.moveCall({
    target: `${pkg}::payroll::delete`,
    arguments: [tx.object(input.teamObjectId)],
  });
  applySponsoredTail(tx, sponsor, gasPrice);
  const bytes = await tx.build({ client: sui() as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Read the created `Team` object id out of a confirmed create tx. Retries with
 * backoff because fullnode read indexing lags ~1–3s behind execution (same
 * shape as parseCreatedStreamObjectId).
 */
export async function parseCreatedTeamObjectId(
  digest: string
): Promise<string | null> {
  const pkg = payrollPackageId();
  if (!pkg) return null;
  const prefix = teamObjectTypePrefix(pkg);

  const DELAYS_MS = [0, 800, 1200, 2000, 3000];
  for (let attempt = 0; attempt < DELAYS_MS.length; attempt++) {
    if (DELAYS_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
    let tx;
    try {
      tx = await getNormalizedTransaction(digest);
    } catch (err) {
      console.warn(
        `[payroll] parseCreatedTeamObjectId getTransaction failed (attempt ${attempt + 1}/${DELAYS_MS.length}) digest=${digest}: ${(err as Error).message}`
      );
      continue;
    }
    if (tx.status !== "success") return null;
    for (const oc of tx.objectChanges) {
      if (oc.kind !== "created") continue;
      const ty = (oc.objectType ?? "").toLowerCase();
      if (ty.startsWith(prefix)) return oc.objectId;
    }
    return null;
  }
  return null;
}
