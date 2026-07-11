import "server-only";

import { bcs } from "@mysten/sui/bcs";
import { sui } from "./sui";

/**
 * gRPC-backed JSON-RPC-compatibility client for `@t2000/sdk`'s NaviAdapter.
 *
 * WHY THIS EXISTS
 * ---------------
 * NAVI's SDK (and the Pyth SDK it calls through for oracle refresh) was
 * written against the legacy `SuiClient` JSON-RPC surface. It invokes five
 * client methods:
 *
 *   1. `devInspectTransactionBlock({ transactionBlock, sender })`
 *   2. `getObject({ id, options:{ showContent } })`
 *   3. `multiGetObjects({ ids, options:{ showContent } })`
 *   4. `getDynamicFieldObject({ parentId, name })`
 *   5. `getCoins({ owner, coinType, cursor })` / `getBalance({ owner, coinType })`
 *
 * Talise's transport is gRPC-only (`sui()` → SuiGrpcClient). This module maps
 * each of those onto the gRPC primitives and reshapes the results back into
 * the JSON-RPC shapes the SDK reads, so the adapter runs unmodified over gRPC
 * — no JSON-RPC fullnode, no Shinami Node Service.
 *
 * WHICH METHODS ARE ON THE MONEY PATH
 * -----------------------------------
 * Talise calls exactly three adapter entry points:
 *   - `addSaveToTx`   (supply)   — builds MoveCalls from NAVI's open-API
 *                                  config/pools over HTTP; touches NO client
 *                                  method. Pure PTB assembly.
 *   - `getPositions`  (withdraw) — issues `devInspectTransactionBlock` for
 *                                  emode account caps + `get_user_state`.
 *                                  Decodes `vector<UserStateInfo>` from BCS.
 *   - `addWithdrawToTx` (withdraw) — `getPositions` (devInspect) + a
 *                                  best-effort oracle refresh. The refresh
 *                                  reads Pyth objects (`getObject` /
 *                                  `getDynamicFieldObject` / `multiGetObjects`)
 *                                  to decide whether to PUSH fresh Pyth VAAs
 *                                  into the PTB. It is wrapped in try/catch by
 *                                  the SDK, and the on-chain
 *                                  `oracle_pro::update_single_price_v2` MoveCall
 *                                  is appended regardless of the read result.
 *                                  WARNING: the try/catch does NOT undo partial
 *                                  tx mutation. If the SDK's VAA-push branch runs
 *                                  and then a price-table read throws mid-way, it
 *                                  can leave orphaned commands (an undestroyed
 *                                  Pyth hot potato) in the PTB, which then aborts.
 *                                  Over this gRPC client that price-table read
 *                                  DOES fail, so the withdraw path passes
 *                                  `skipPythUpdate: true` (see navi-supply.ts) to
 *                                  disable that branch entirely. The health-check
 *                                  `update_single_price_v2` calls still run and
 *                                  read the keeper-refreshed on-chain Pyth price.
 *
 * The `getCoins`/`getBalance`/`getObject`-parsed-content paths are only hit by
 * SDK helpers Talise does NOT call (`buildSaveTx` self-sources coins;
 * `getFinancialSummary`/`getRates` read balances). They are implemented here
 * for completeness + robustness, but are not on Talise's deposit/withdraw
 * critical path.
 *
 * VALIDATION: see `scripts/navi-grpc-validate.mjs` — read-only mainnet probes
 * proving the position read matches the JSON-RPC path bit-for-bit and the
 * supply/withdraw PTBs build with the expected MoveCalls.
 */

type JsonRpcContent = {
  dataType: "moveObject";
  type: string;
  hasPublicTransfer?: boolean;
  fields: Record<string, unknown>;
};

type JsonRpcObjectData = {
  objectId: string;
  version: string;
  digest: string;
  type: string;
  content: JsonRpcContent | null;
};

type JsonRpcGetObjectResponse = { data: JsonRpcObjectData | null; error?: unknown };

/**
 * Convert the gRPC `json` object representation (flat nested objects) into the
 * JSON-RPC `content.fields` shape (every nested Move struct wrapped in
 * `{ fields: … }`).
 *
 * gRPC `getObject({ include:{ json:true } })` returns, e.g.:
 *   { price_info: { price_feed: { price: { price:{magnitude,negative}, conf } } } }
 * whereas the Pyth/NAVI SDK reads:
 *   content.fields.price_info.fields.price_feed.fields.price.fields.price.fields.magnitude
 *
 * i.e. the SDK expects each nested struct wrapped under a `fields` key. We
 * reproduce that by recursively wrapping every plain object (not arrays, not
 * scalars) as `{ fields: <recursively-wrapped> }`. Scalars, strings, and
 * arrays pass through unchanged. This is a STRUCTURAL transform — it does not
 * know struct names, so it works for any Move type the SDK navigates, as long
 * as every level it descends is a nested object in the gRPC json (verified
 * true for the Pyth State + PriceInfoObject reads on the withdraw path).
 */
function wrapFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(wrapFields);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = wrapFields(v);
    }
    return { fields: out };
  }
  return value;
}

/** Top level of an object's json → `content.fields` (fields NOT re-wrapped at
 * the top; only nested structs get `.fields`). */
function jsonToContentFields(json: unknown): Record<string, unknown> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    out[k] = wrapFields(v);
  }
  return out;
}

type GrpcObject = {
  objectId: string;
  version: string;
  digest: string;
  type: string;
  json?: Record<string, unknown> | null;
};

function grpcObjectToJsonRpc(obj: GrpcObject | undefined | null): JsonRpcGetObjectResponse {
  if (!obj) return { data: null };
  const content: JsonRpcContent | null =
    obj.json && typeof obj.json === "object"
      ? {
          dataType: "moveObject",
          type: obj.type,
          hasPublicTransfer: false,
          fields: jsonToContentFields(obj.json),
        }
      : null;
  return {
    data: {
      objectId: obj.objectId,
      version: String(obj.version),
      digest: obj.digest,
      type: obj.type,
      content,
    },
  };
}

/** Serialize a JSON-RPC `DynamicFieldName` value into BCS bytes for gRPC.
 *
 * The Pyth SDK issues two dynamic-field lookups:
 *   1. name = { type: "vector<u8>", value: "price_info" }
 *   2. name = { type: "…::price_identifier::PriceIdentifier",
 *               value: { bytes: number[] } }
 */
function serializeDynamicFieldName(name: {
  type: string;
  value: unknown;
}): Uint8Array {
  const t = name.type;
  if (t === "vector<u8>") {
    // value is either a string (interpreted as UTF-8 bytes, matching how
    // Pyth stores b"price_info") or an explicit byte array.
    const v = name.value;
    const bytes =
      typeof v === "string"
        ? Array.from(new TextEncoder().encode(v))
        : Array.isArray(v)
          ? (v as number[])
          : [];
    return bcs.vector(bcs.u8()).serialize(bytes).toBytes();
  }
  if (/::price_identifier::PriceIdentifier$/.test(t)) {
    // Move struct `PriceIdentifier { bytes: vector<u8> }`.
    const inner = (name.value as { bytes?: number[] })?.bytes ?? [];
    const PriceIdentifier = bcs.struct("PriceIdentifier", {
      bytes: bcs.vector(bcs.u8()),
    });
    return PriceIdentifier.serialize({ bytes: inner }).toBytes();
  }
  // Fallback: best-effort — treat an object with `bytes` as a byte vector.
  const maybeBytes = (name.value as { bytes?: number[] })?.bytes;
  if (Array.isArray(maybeBytes)) {
    return bcs.vector(bcs.u8()).serialize(maybeBytes).toBytes();
  }
  throw new Error(`unsupported dynamic field name type: ${t}`);
}

/**
 * Build the JSON-RPC-compatibility client the NaviAdapter expects, backed by
 * the shared gRPC `sui()`.
 *
 * Each method mirrors the exact JSON-RPC method shape (`data.content.fields`,
 * `results[i].returnValues[j][0]`, `{ data:[{coinObjectId,…}], hasNextPage }`)
 * that `@t2000/sdk` (and the Pyth SDK it delegates to) read from.
 */
export function naviGrpcCompatClient(): unknown {
  const client = sui();

  return {
    // ── devInspectTransactionBlock ────────────────────────────────────────
    // Maps to gRPC simulateTransaction in gasless read mode. The SDK reads
    // `results[i].returnValues[j][0]` (a byte array); gRPC returns
    // `commandResults[i].returnValues[j].bcs` (Uint8Array). Reshape 1:1.
    async devInspectTransactionBlock(params: {
      transactionBlock: unknown;
      sender: string;
    }) {
      const res = (await client.simulateTransaction({
        transaction: params.transactionBlock as never,
        checksEnabled: false,
        include: { commandResults: true },
      } as never)) as {
        commandResults?: Array<{
          returnValues?: Array<{ bcs?: Uint8Array }>;
        }>;
      };
      const results = (res.commandResults ?? []).map((cr) => ({
        returnValues: (cr.returnValues ?? []).map((rv) => {
          const bytes = rv.bcs
            ? Array.from(rv.bcs)
            : ([] as number[]);
          // JSON-RPC returnValue is `[bytes, typeTag]`. The SDK only reads
          // index [0] (the bytes); the type tag is unused, so "" is safe.
          return [bytes, ""] as [number[], string];
        }),
      }));
      return { results, effects: undefined, error: undefined };
    },

    // ── getObject ─────────────────────────────────────────────────────────
    async getObject(params: {
      id: string;
      options?: { showContent?: boolean };
    }): Promise<JsonRpcGetObjectResponse> {
      try {
        const res = (await client.getObject({
          objectId: params.id,
          include: { json: true },
        } as never)) as { object?: GrpcObject };
        return grpcObjectToJsonRpc(res.object);
      } catch (err) {
        return { data: null, error: err };
      }
    },

    // ── multiGetObjects ───────────────────────────────────────────────────
    async multiGetObjects(params: {
      ids: string[];
      options?: { showContent?: boolean };
    }): Promise<JsonRpcGetObjectResponse[]> {
      const res = (await client.getObjects({
        objectIds: params.ids,
        include: { json: true },
      } as never)) as { objects?: Array<GrpcObject | Error> };
      return (res.objects ?? []).map((o) =>
        o instanceof Error
          ? { data: null, error: o }
          : grpcObjectToJsonRpc(o as GrpcObject)
      );
    },

    // ── getDynamicFieldObject ─────────────────────────────────────────────
    // The Pyth SDK's `getPriceTableInfo` reads `.data.type` + `.data.objectId`;
    // `getPriceFeedObjectId` reads `.data.content.fields.value`. We resolve the
    // dynamic field id via gRPC `getDynamicField`, then fetch that object with
    // `getObject` (json) so both shapes are populated.
    async getDynamicFieldObject(params: {
      parentId: string;
      name: { type: string; value: unknown };
    }): Promise<JsonRpcGetObjectResponse> {
      try {
        const nameBcs = serializeDynamicFieldName(params.name);
        const df = (await client.getDynamicField({
          parentId: params.parentId,
          name: { type: params.name.type, bcs: nameBcs },
        } as never)) as {
          dynamicField?: {
            fieldId: string;
            type: string;
            valueType?: string;
            $kind?: string;
            childId?: string;
            value?: { type?: string; bcs?: Uint8Array };
          };
        };
        const dfld = df.dynamicField;
        if (!dfld) return { data: null };

        // For a dynamic OBJECT field ($kind DynamicObject), childId is the
        // wrapped object's id — fetch it directly so json/content is populated.
        // For a plain dynamic field, the field wrapper object itself (fieldId)
        // carries `{ name, value }`; fetch it and expose value under fields.
        const targetId = dfld.childId ?? dfld.fieldId;
        const objRes = (await client.getObject({
          objectId: targetId,
          include: { json: true },
        } as never)) as { object?: GrpcObject };
        return grpcObjectToJsonRpc(objRes.object);
      } catch (err) {
        return { data: null, error: err };
      }
    },

    // ── getCoins ──────────────────────────────────────────────────────────
    async getCoins(params: {
      owner: string;
      coinType?: string;
      cursor?: string | null;
      limit?: number;
    }) {
      const res = (await client.listCoins({
        owner: params.owner,
        coinType: params.coinType,
        cursor: params.cursor ?? undefined,
        limit: params.limit,
      } as never)) as {
        objects?: Array<{
          objectId: string;
          version: string;
          digest: string;
          balance: string;
          type: string;
        }>;
        hasNextPage?: boolean;
        cursor?: string | null;
      };
      return {
        data: (res.objects ?? []).map((c) => ({
          coinObjectId: c.objectId,
          version: String(c.version),
          digest: c.digest,
          balance: c.balance,
          coinType: c.type,
        })),
        hasNextPage: !!res.hasNextPage,
        nextCursor: res.cursor ?? null,
      };
    },

    // ── getBalance ────────────────────────────────────────────────────────
    async getBalance(params: { owner: string; coinType?: string }) {
      const res = (await client.getBalance({
        owner: params.owner,
        coinType: params.coinType,
      } as never)) as { balance?: { balance?: string; coinType?: string } };
      const totalBalance = res.balance?.balance ?? "0";
      return {
        coinType: res.balance?.coinType ?? params.coinType ?? "0x2::sui::SUI",
        totalBalance,
        coinObjectCount: 0,
        lockedBalance: {},
      };
    },
  };
}
