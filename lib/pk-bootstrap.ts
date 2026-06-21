import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { PaymentKitClient } from "@mysten/payment-kit";
import { sui } from "./sui";
import { memoTtl } from "./perf-cache";

const REGISTRY_NAME = "talise";

/**
 * Lazily mints the global `talise` PaymentRegistry on chain if it doesn't
 * exist yet. Idempotent — repeated calls within the process lifetime no-op
 * after the first success, and across processes the on-chain object check
 * short-circuits the mint.
 *
 * Without this, `processRegistryPayment` aborts and the tx falls back to
 * a plain transfer — which is exactly why suivision was showing "none" as
 * the transaction kind.
 *
 * Called from `/api/zk/warmup` so the registry is ready before the user's
 * first send. Also safe to call from anywhere else that needs to ensure
 * the registry exists.
 */
export async function ensurePaymentRegistry(): Promise<{ ok: true; minted: boolean }>
export async function ensurePaymentRegistry() {
  // In-process cache: once we've verified the registry exists, never check
  // again for the life of this Node process. Effectively a singleton.
  return memoTtl("pk:registry:exists", 24 * 60 * 60 * 1000, async () => {
    const client = sui();
    const pk = new PaymentKitClient({ client: client as never });
    const registryId = pk.getRegistryIdFromName(REGISTRY_NAME);

    // Fast path: registry already exists on chain (idempotent across procs).
    // gRPC `getObject` THROWS when an object doesn't exist (JSON-RPC
    // returned `{ data: null }`); we treat any error as "not found" and
    // fall through to mint.
    try {
      const existing = await client.getObject({ objectId: registryId });
      if (existing.object?.objectId) {
        return { ok: true as const, minted: false };
      }
    } catch {
      /* fall through to mint */
    }

    // Need to mint. The operator key (the same wallet that owns talise.sui
    // and mints subnames) pays its own gas — one-time ~0.005 SUI cost.
    const key = process.env.TALISE_PK_OPERATOR_KEY ?? process.env.TALISE_SUINS_OPERATOR_KEY;
    if (!key) {
      throw new Error(
        "ensurePaymentRegistry: no operator key in env (TALISE_PK_OPERATOR_KEY / TALISE_SUINS_OPERATOR_KEY)"
      );
    }
    const operator = Ed25519Keypair.fromSecretKey(key);
    const operatorAddr = operator.getPublicKey().toSuiAddress();

    const tx = new Transaction();
    // `payment_kit::create_registry` returns `(PaymentRegistry,
    // RegistryAdminCap)` — verified against the on-chain Move source.
    // Earlier revision aborted with `CommandArgumentError
    // InvalidResultArity { result_idx: 0 }` because it treated the
    // tuple as a single value (transferring the registry instead of
    // the cap, and leaving the cap unconsumed → UnusedValueWithoutDrop).
    //
    //   index 0 → PaymentRegistry  → `payment_kit::share` so anyone
    //                                 can write PaymentRecord dynamic
    //                                 fields under it
    //   index 1 → RegistryAdminCap → transfer to operator wallet for
    //                                 future setConfig / withdrawFromRegistry
    const created = tx.add(
      pk.calls.createRegistry({ registryName: REGISTRY_NAME })
    );
    tx.moveCall({
      target: "@mysten/payment-kit::payment_kit::share",
      arguments: [created[0]],
    });
    tx.transferObjects([created[1]], operatorAddr);
    tx.setSender(operatorAddr);

    const bytes = await tx.build({ client: client as never });
    const { signature } = await operator.signTransaction(bytes);

    // gRPC `executeTransaction` — discriminated-union response.
    const result = (await client.executeTransaction({
      transaction: bytes,
      signatures: [signature],
      include: { effects: true },
    })) as Record<string, unknown>;

    if ((result.$kind as string | undefined) === "FailedTransaction") {
      const failed = result.FailedTransaction as
        | { effects?: { status?: { error?: unknown } } }
        | undefined;
      const err = failed?.effects?.status?.error;
      throw new Error(
        `ensurePaymentRegistry: mint failed — ${
          (typeof err === "string" && err) ||
          (typeof err === "object" &&
            err !== null &&
            "message" in err &&
            (err as { message?: string }).message) ||
          "unknown"
        }`
      );
    }

    const txInner = result.Transaction as
      | {
          digest?: string;
          effects?: { status?: { success?: boolean; error?: unknown } };
        }
      | undefined;
    if (txInner?.effects?.status && txInner.effects.status.success === false) {
      const err = txInner.effects.status.error;
      throw new Error(
        `ensurePaymentRegistry: mint failed — ${
          (typeof err === "string" && err) ||
          (typeof err === "object" &&
            err !== null &&
            "message" in err &&
            (err as { message?: string }).message) ||
          "unknown"
        }`
      );
    }

    console.log(
      `[pk-bootstrap] minted PaymentRegistry "${REGISTRY_NAME}" (digest=${txInner?.digest ?? ""})`
    );
    return { ok: true as const, minted: true };
  });
}
