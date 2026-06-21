import "server-only";

import { SHIELD_RPC } from "./onchain";

/**
 * JSON-RPC object-resolution build plugin for shielded PTBs.
 *
 * The relayer/sponsor builds a CLIENT-assembled `transact` PTB whose inputs are
 * `UnresolvedObject`s (the shared `ShieldedPool` + the relayer's zero-coin source,
 * referenced by id only). The gRPC client's built-in resolution is unreliable for
 * these here — in particular it does not reliably mark the SHARED pool object with
 * its `initialSharedVersion` + `mutable`, so `tx.build({ client })` throws and the
 * relayer never submits (the withdraw silently fails and the recipient is never
 * paid). This plugin resolves every `UnresolvedObject` via `sui_multiGetObjects`
 * over JSON-RPC and pins it correctly — SharedObject vs ImmOrOwnedObject — exactly
 * as the proven CLI lifecycle harness does.
 *
 * Usage: `tx.addBuildPlugin(jsonRpcResolutionPlugin()); await tx.build({ client })`.
 */
async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(SHIELD_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

export function jsonRpcResolutionPlugin() {
  return async (
    transactionData: { inputs: any[] },
    _options: unknown,
    next: () => Promise<void>
  ): Promise<void> => {
    const ids = new Set<string>();
    for (const inp of transactionData.inputs) {
      if (inp.$kind === "UnresolvedObject" && inp.UnresolvedObject?.objectId) {
        ids.add(inp.UnresolvedObject.objectId);
      }
    }
    if (ids.size > 0) {
      const objs = await rpc("sui_multiGetObjects", [[...ids], { showOwner: true }]);
      const byId = new Map<string, { version: string; digest: string; owner: any }>();
      for (const o of objs ?? []) {
        const d = o?.data;
        if (d) byId.set(d.objectId, { version: String(d.version), digest: d.digest, owner: d.owner });
      }
      for (const inp of transactionData.inputs) {
        if (inp.$kind !== "UnresolvedObject") continue;
        const id = inp.UnresolvedObject.objectId;
        const info = byId.get(id);
        if (!info) throw new Error(`shield resolve: object ${id} not found on mainnet`);
        const shared = info.owner?.Shared;
        delete inp.UnresolvedObject;
        if (shared) {
          inp.$kind = "Object";
          inp.Object = {
            $kind: "SharedObject",
            SharedObject: {
              objectId: id,
              initialSharedVersion: String(shared.initial_shared_version),
              mutable: true,
            },
          };
        } else {
          inp.$kind = "Object";
          inp.Object = {
            $kind: "ImmOrOwnedObject",
            ImmOrOwnedObject: { objectId: id, version: info.version, digest: info.digest },
          };
        }
      }
    }
    await next();
  };
}
