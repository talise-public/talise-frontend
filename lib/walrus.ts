import "server-only";

/**
 * Walrus blob storage, Sui's decentralized storage network.
 *
 * Used for claimable money-link NOTES: the sender's (encrypted) message is
 * stored as a Walrus blob and the resulting blob id is recorded on the cheque
 * row; the claim page reads the blob back from the aggregator and decrypts it.
 *
 * HTTP publisher/aggregator API (no SDK needed):
 *   • store:  PUT  {publisher}/v1/blobs?epochs=N   (body = raw bytes)
 *   • read:   GET  {aggregator}/v1/blobs/{blobId}
 *
 * Defaults target Walrus testnet (public Mysten endpoints); override with
 * WALRUS_PUBLISHER / WALRUS_AGGREGATOR for mainnet or a self-hosted node.
 */

const DEFAULT_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";
const DEFAULT_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";

// Loud misconfig guard: a MAINNET app that leaves WALRUS_* unset falls back to
// the TESTNET endpoints above. Testnet blobs are pruned aggressively, so an
// encrypted money-link note stored there can silently vanish. We keep the
// testnet default (mainnet Walrus needs a funded publisher, so we don't guess
// an endpoint), but warn once at load so the misconfiguration is visible in
// prod logs instead of degrading silently. Set WALRUS_PUBLISHER / WALRUS_AGGREGATOR.
if (
  (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet").toLowerCase() === "mainnet" &&
  (!process.env.WALRUS_PUBLISHER || !process.env.WALRUS_AGGREGATOR)
) {
  console.warn(
    "[walrus] MAINNET app is using the TESTNET Walrus default, set WALRUS_PUBLISHER/WALRUS_AGGREGATOR to a mainnet endpoint; testnet blobs (cheque notes) may be pruned."
  );
}

function publisher(): string {
  return (process.env.WALRUS_PUBLISHER || DEFAULT_PUBLISHER).replace(/\/+$/, "");
}
function aggregator(): string {
  return (process.env.WALRUS_AGGREGATOR || DEFAULT_AGGREGATOR).replace(/\/+$/, "");
}

export class WalrusError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "WalrusError";
  }
}

type StoreResponse = {
  newlyCreated?: { blobObject?: { blobId?: string } };
  alreadyCertified?: { blobId?: string };
};

/**
 * Store bytes on Walrus and return the content-addressed blob id. `epochs` is
 * how long Walrus keeps it (testnet epochs are short; 5 is plenty for a
 * money-link note's lifetime). Idempotent by content: re-storing identical
 * bytes returns the same blob id (`alreadyCertified`).
 */
export async function storeBlob(
  data: Uint8Array,
  opts: { epochs?: number; timeoutMs?: number } = {}
): Promise<string> {
  const epochs = opts.epochs ?? 5;
  const url = `${publisher()}/v1/blobs?epochs=${epochs}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      body: data as unknown as BodyInit,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new WalrusError(`walrus store failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new WalrusError(`walrus store → ${res.status}`, res.status);
  }
  const json = (await res.json()) as StoreResponse;
  const blobId = json.newlyCreated?.blobObject?.blobId ?? json.alreadyCertified?.blobId;
  if (!blobId) throw new WalrusError("walrus store: no blobId in response");
  return blobId;
}

/** Read a blob back from the Walrus aggregator by id. */
export async function readBlob(
  blobId: string,
  opts: { timeoutMs?: number } = {}
): Promise<Uint8Array> {
  const url = `${aggregator()}/v1/blobs/${encodeURIComponent(blobId)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (e) {
    throw new WalrusError(`walrus read failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new WalrusError(`walrus read ${blobId} → ${res.status}`, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Convenience: store a UTF-8 string. */
export async function storeText(text: string, epochs?: number): Promise<string> {
  return storeBlob(new TextEncoder().encode(text), { epochs });
}

/** Public aggregator URL for a blob (handy for clients / debugging). */
export function blobUrl(blobId: string): string {
  return `${aggregator()}/v1/blobs/${encodeURIComponent(blobId)}`;
}
