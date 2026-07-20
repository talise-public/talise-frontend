/**
 * Client-side zkLogin toolkit. Runs in the browser only.
 *
 * Responsibilities:
 *  - Generate the ephemeral Ed25519 keypair before OAuth and persist it in
 *    sessionStorage.
 *  - Compute the nonce that ties Google's JWT to the ephemeral key.
 *  - Build PTBs, sign with the ephemeral private key, and submit.
 *  - Talk to /api/sign on our server which holds the JWT and proxies to the
 *    Mysten prover; we never expose the JWT or salt to JS.
 *
 * The ephemeral private key is the only sensitive value held in the browser.
 * It rotates on every fresh sign-in (the user closes/reopens the tab).
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import {
  generateNonce,
  generateRandomness,
} from "@mysten/sui/zklogin";

const ZK_STORAGE_KEY = "talise:zk:eph";
// Metadata-only expiry marker (a timestamp, NO key material) kept in
// localStorage so EVERY tab can tell "the signing session expired" apart
// from "this tab never had a key" (sessionStorage is per-tab). Written at
// sign-in, cleared at sign-out.
const ZK_EXPIRY_MARKER = "talise:zk:expiresAt";
// Match Google's default JWT lifetime so the key never outlives its proof.
const EPHEMERAL_TTL_MS = 55 * 60 * 1000;

/**
 * Cached zkLogin proof, generated server-side once per session via Shinami
 * (2-4s), then reused for every subsequent signing without another prover
 * round trip. Same shape the server's `mintZkProof` returns. Stays valid
 * for the lifetime of the ephemeral key.
 */
export type StoredZkProof = {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
};

type StoredAuth = {
  privKeyB64: string;
  pubKeyB64: string;
  randomness: string;
  maxEpoch: number;
  createdAt: number;
  /** Cached proof from the first server signing. Reused on subsequent sends. */
  proof?: StoredZkProof;
};

function readStored(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  // SESSION-SCOPE ONLY. The stored blob contains the ephemeral signing
  // PRIVATE key, a same-origin script (any XSS) that can read it can drain
  // the wallet. localStorage persists + is readable across the whole origin,
  // so we never keep the key there. Prefer sessionStorage; if a legacy
  // localStorage copy exists (older builds wrote both), migrate it into
  // sessionStorage ONCE and purge the localStorage copy so a returning user
  // isn't logged out by this change.
  let raw = sessionStorage.getItem(ZK_STORAGE_KEY);
  if (!raw) {
    const legacy = localStorage.getItem(ZK_STORAGE_KEY);
    if (legacy) {
      sessionStorage.setItem(ZK_STORAGE_KEY, legacy);
      localStorage.removeItem(ZK_STORAGE_KEY);
      raw = legacy;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed.createdAt || Date.now() - parsed.createdAt > EPHEMERAL_TTL_MS) {
      clearStored();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(s: StoredAuth) {
  // sessionStorage ONLY, never localStorage (the blob holds the ephemeral
  // signing key; see readStored). The OAuth sign-in redirect stays in the
  // same tab, so sessionStorage survives it. Defensively purge any legacy
  // localStorage copy a prior build may have written.
  sessionStorage.setItem(ZK_STORAGE_KEY, JSON.stringify(s));
  try {
    localStorage.removeItem(ZK_STORAGE_KEY);
  } catch {
    /* private mode / storage disabled, non-fatal */
  }
}

export function clearStored() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ZK_STORAGE_KEY);
  sessionStorage.removeItem(ZK_STORAGE_KEY);
}

/** Remove the cross-tab expiry marker (full sign-out). */
export function clearExpiryMarker() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ZK_EXPIRY_MARKER);
  } catch {
    /* ignore */
  }
}

/**
 * True when a signing session WAS minted on this browser and its ephemeral
 * window has lapsed, the cue to sign the user out for a clean re-sign-in
 * (cookies may still be valid for days, but the wallet can no longer sign).
 * False when there's no marker at all (never signed in here / already
 * signed out) or the session is still inside its window.
 */
export function signingSessionExpired(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(ZK_EXPIRY_MARKER);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() > at;
  } catch {
    return false;
  }
}

export function hasEphemeralKey(): boolean {
  return !!readStored();
}

/**
 * Read the cached zk proof if we have one for the current ephemeral key.
 * Returns null if there's no key OR no cached proof yet (cold session).
 */
export function readCachedProof(): StoredZkProof | null {
  const s = readStored();
  return s?.proof ?? null;
}

/**
 * Persist a freshly-minted zk proof so the NEXT sign call skips the
 * 2-4s Shinami round trip. The proof is bound to the ephemeral key in
 * storage, if the key is rotated (sign-in flow), the proof goes with it.
 */
export function writeCachedProof(proof: StoredZkProof): void {
  const s = readStored();
  if (!s) return;
  writeStored({ ...s, proof });
}

/**
 * Snapshot of the browser-side ephemeral identity, shaped for our
 * `/api/t2000/execute` route. The route reconstructs the zkLogin signer
 * from these fields. Returns null if no ephemeral key is present.
 *
 * Note: this includes the ephemeral PRIVATE key. The key is a one-shot
 * 55-minute artifact that we deliberately treat as session-scope -
 * acceptable for a same-origin POST over TLS.
 */
export function readEphemeralForT2000(): {
  ephemeralPrivateKey: string;
  ephemeralPubKeyB64: string;
  maxEpoch: number;
  randomness: string;
  /** Cached proof if any. Server skips Shinami when present. */
  cachedProof?: StoredZkProof;
} | null {
  const s = readStored();
  if (!s) return null;
  return {
    ephemeralPrivateKey: s.privKeyB64,
    ephemeralPubKeyB64: s.pubKeyB64,
    maxEpoch: s.maxEpoch,
    randomness: s.randomness,
    cachedProof: s.proof,
  };
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Run the full client-side OAuth bootstrap: provision an ephemeral key, set
 * the server-side state cookie, optionally stash a return-to path, then
 * redirect to Google. Caller never returns from this function, the page
 * unloads as part of the redirect.
 */
export async function triggerOauthSignIn(opts?: { returnTo?: string }) {
  if (typeof window === "undefined") return;

  // Fire the three independent pre-redirect calls CONCURRENTLY so the Google
  // screen opens as soon as the slowest settles, not the sum of all three:
  //   • return-to cookie (optional)
  //   • ephemeral key + nonce (needs the Sui epoch, now edge-cached)
  //   • OAuth state cookie
  const state = crypto.randomUUID();
  const returnToP =
    opts?.returnTo && opts.returnTo.startsWith("/")
      ? fetch("/api/auth/return-to", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ returnTo: opts.returnTo }),
        }).catch(() => {})
      : Promise.resolve(undefined);
  const stateP = fetch("/api/auth/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });

  const [, { nonce }, stateRes] = await Promise.all([
    returnToP,
    provisionEphemeralAuth(),
    stateP,
  ]);
  if (!stateRes.ok) throw new Error("could not prepare state");

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("OAuth env missing");

  // Derive the redirect URI from the CURRENT origin so the authorize
  // leg (this URL) matches the token-exchange leg
  // (`redirectUriFromRequest(req)` in /auth/callback, which reads the
  // incoming request's host). A static NEXT_PUBLIC env baked at build
  // time gets out of sync when the same code is served from multiple
  // hosts (`talise.io/waitlist` vs `app.talise.io` mobile bridge),
  // which Google rejects as `redirect_uri_mismatch`. Falling back to
  // the env only if `window` is missing (SSR, shouldn't happen here).
  //
  // NOTE: every host you serve from must be registered as an
  // Authorized redirect URI in Google Cloud Console:
  //   https://talise.io/auth/callback
  //   https://app.talise.io/auth/callback
  //   (plus any preview deploy hosts you actually use)
  // Use the static NEXT_PUBLIC_GOOGLE_REDIRECT_URI rather than
  // window.location.origin, Vercel may have us on www.talise.io OR
  // talise.io and Google rejects unregistered URIs. The env pins the
  // ONE host that's registered in Google Cloud Console. The callback
  // route reads the matching GOOGLE_REDIRECT_URI server-side for the
  // token exchange, so the two legs always agree.
  const redirect = process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI;
  if (!redirect) throw new Error("NEXT_PUBLIC_GOOGLE_REDIRECT_URI not set");

  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("state", state);
  u.searchParams.set("access_type", "online");
  u.searchParams.set("prompt", "select_account");
  window.location.href = u.toString();
}

function clientNetwork(): "mainnet" | "testnet" {
  const v = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet").toLowerCase();
  return v === "testnet" ? "testnet" : "mainnet";
}

let _sui: SuiGrpcClient | null = null;
function suiClient(): SuiGrpcClient {
  if (_sui) return _sui;
  const net = clientNetwork();
  // gRPC-Web endpoint for the browser client. On mainnet we route through
  // Hayabusa (the same transparent gRPC-Web proxy the server uses), it's
  // CORS-ready and races multiple fullnodes internally, so it's both faster
  // AND more reliable than a single direct fullnode for a browser with no
  // fallback chain. Env-overridable (NEXT_PUBLIC_HAYABUSA_GRPC_URL="" → direct).
  const HAYABUSA = "https://hayabusa.mainnet.unconfirmed.cloud:443";
  const baseUrl =
    net === "mainnet"
      ? process.env.NEXT_PUBLIC_HAYABUSA_GRPC_URL ?? HAYABUSA
      : "https://fullnode.testnet.sui.io:443";
  _sui = new SuiGrpcClient({ network: net, baseUrl });
  return _sui;
}

/**
 * Fetch the current Sui epoch from our server proxy (avoids importing the
 * heavy Sui SDK just to read one number when generating the nonce).
 */
async function fetchCurrentEpoch(): Promise<number> {
  const r = await fetch("/api/sui/epoch", { cache: "no-store" });
  if (!r.ok) throw new Error("could not fetch current epoch");
  const { epoch } = await r.json();
  return Number(epoch);
}

/**
 * Generate an ephemeral keypair, compute the nonce, persist everything in
 * sessionStorage, and return the nonce that gets sent to Google.
 */
export async function provisionEphemeralAuth(): Promise<{ nonce: string }> {
  const eph = Ed25519Keypair.generate();
  const randomness = generateRandomness();
  const currentEpoch = await fetchCurrentEpoch();
  // Valid for ~10 epochs (~10 days on mainnet). Plenty for an active session.
  const maxEpoch = currentEpoch + 10;

  const pubKey = eph.getPublicKey();
  const nonce = generateNonce(pubKey, maxEpoch, randomness);

  const priv = eph.getSecretKey(); // bech32 string, includes signature scheme byte
  writeStored({
    privKeyB64: priv,
    pubKeyB64: toBase64(pubKey.toRawBytes()),
    randomness,
    maxEpoch,
    createdAt: Date.now(),
  });
  try {
    localStorage.setItem(ZK_EXPIRY_MARKER, String(Date.now() + EPHEMERAL_TTL_MS));
  } catch {
    /* storage blocked, the per-send bounce still covers expiry */
  }

  return { nonce };
}

/** Reconstruct the ephemeral keypair from sessionStorage. */
function loadEphemeralKeypair(): { keypair: Ed25519Keypair; stored: StoredAuth } {
  const stored = readStored();
  if (!stored) {
    throw new Error("No ephemeral key in session. Please sign in again.");
  }
  const keypair = Ed25519Keypair.fromSecretKey(stored.privKeyB64);
  return { keypair, stored };
}

/**
 * Build, sign, and submit a transaction. Server proxies the ZK proof so the
 * JWT never leaves our backend.
 *
 * `buildTx` can be sync or async, async lets it fetch coin objects for asset
 * transfers (USDC, etc.) before composing the PTB.
 *
 * Returns the transaction digest on success.
 */
export type SignAndSubmitResult = {
  digest: string;
  /** Object ids created in the transaction, keyed by their last type segment. */
  created: Record<string, string[]>;
};

function sponsorshipEnabled(): boolean {
  // Default ON when unset, gasless is the better default. Set
  // NEXT_PUBLIC_SPONSOR_ENABLED=false to force the user to pay their own gas.
  const v = process.env.NEXT_PUBLIC_SPONSOR_ENABLED;
  if (v === undefined || v === "") return true;
  return v.toLowerCase() !== "false";
}

/** Group created object IDs by the last segment of their fully-qualified type. */
function groupCreated(
  changes: ReadonlyArray<unknown> | null | undefined
): Record<string, string[]> {
  const created: Record<string, string[]> = {};
  for (const change of changes ?? []) {
    const c = change as { type?: string; objectType?: string; objectId?: string };
    if (c.type !== "created" || !c.objectId) continue;
    const fqType = c.objectType ?? "";
    const last = fqType.split("::").pop()?.replace(/<.*$/, "") ?? "Unknown";
    (created[last] ??= []).push(c.objectId);
  }
  return created;
}

export async function signAndSubmit(
  buildTx: (tx: Transaction) => void | Promise<void>,
  opts: { senderAddress: string; sponsored?: boolean }
): Promise<SignAndSubmitResult> {
  const { keypair, stored } = loadEphemeralKeypair();

  const tx = new Transaction();
  tx.setSender(opts.senderAddress);
  await buildTx(tx);

  const client = suiClient();
  const useSponsored = opts.sponsored ?? sponsorshipEnabled();

  if (useSponsored) {
    // Build the transaction kind only, server attaches gas data from the
    // sponsor hot wallet.
    const kindBytes = await tx.build({
      client: client as never,
      onlyTransactionKind: true,
    });

    // Trip 1: server returns the full sponsored TransactionData bytes.
    const sr = await fetch("/api/zk/sponsor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionKindB64: toBase64(kindBytes),
      }),
    });
    if (!sr.ok) {
      const err = await sr.json().catch(() => ({ error: "sponsor failed" }));
      throw new Error(err.error || `sponsor failed (HTTP ${sr.status})`);
    }
    const { bytes } = (await sr.json()) as { bytes: string; digest: string };

    // Sign the full TransactionData bytes with the ephemeral key (sender sig).
    const sponsoredBytes = fromBase64(bytes);
    const { signature: userSignature } = await keypair.signTransaction(
      sponsoredBytes
    );

    // Trip 2: server wraps the ephemeral sig into a zkLoginSignature, adds
    // its own sponsor signature, and broadcasts.
    //
    // We pass `cachedProof` if we have one, the server skips the 2-4s
    // Shinami round trip when provided. On cache miss the server returns
    // `freshProof` in the response so we can persist it for next time.
    const cachedProof = stored.proof;
    const er = await fetch("/api/zk/sponsor-execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bytesB64: bytes,
        ephemeralPubKeyB64: stored.pubKeyB64,
        maxEpoch: stored.maxEpoch,
        randomness: stored.randomness,
        userSignature,
        cachedProof,
      }),
    });
    if (!er.ok) {
      const err = await er.json().catch(() => ({ error: "execute failed" }));
      throw new Error(err.error || `execute failed (HTTP ${er.status})`);
    }
    const { digest, effects, objectChanges, freshProof } = (await er.json()) as {
      digest: string;
      effects?: { status?: { status?: string; error?: string } };
      objectChanges?: unknown[];
      freshProof?: StoredZkProof;
    };

    if (effects?.status?.status && effects.status.status !== "success") {
      const reason = effects.status.error ?? "unknown failure";
      throw new Error(`transaction failed: ${reason}`);
    }

    // First successful tx in this session, persist the proof so every
    // subsequent send skips Shinami entirely.
    if (freshProof) writeCachedProof(freshProof);

    return { digest, created: groupCreated(objectChanges) };
  }

  // Non-sponsored fallback: user pays gas from their own SUI.
  const txBytes = await tx.build({ client: client as never });

  // Ephemeral signature of tx bytes (proves we hold the ephemeral private key).
  const { signature: userSignature } = await keypair.signTransaction(txBytes);

  // Ask our server to call the Mysten prover and wrap the final zkLoginSignature.
  // Server reads JWT + salt from its own httpOnly cookie, we don't send them.
  const r = await fetch("/api/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      txBytesB64: toBase64(txBytes),
      ephemeralPubKeyB64: stored.pubKeyB64,
      maxEpoch: stored.maxEpoch,
      randomness: stored.randomness,
      userSignature,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "sign failed" }));
    throw new Error(err.error || `sign failed (HTTP ${r.status})`);
  }
  const { zkLoginSignature } = await r.json();

  // Submit to Sui RPC via gRPC. The discriminated-union response is
  // either `{ $kind: "Transaction", Transaction: { digest, effects, ... } }`
  // or `{ $kind: "FailedTransaction", FailedTransaction: { ... } }`.
  const exec = (await client.executeTransaction({
    transaction: txBytes,
    signatures: [zkLoginSignature],
    include: { effects: true },
  })) as Record<string, unknown>;

  if ((exec.$kind as string | undefined) === "FailedTransaction") {
    const failed = exec.FailedTransaction as
      | { effects?: { status?: { error?: unknown } } }
      | undefined;
    const errField = failed?.effects?.status?.error;
    const reason =
      (typeof errField === "string" && errField) ||
      (typeof errField === "object" &&
        errField !== null &&
        "message" in errField &&
        (errField as { message?: string }).message) ||
      "unknown failure";
    throw new Error(`transaction failed: ${reason}`);
  }

  const txInner = exec.Transaction as
    | { digest?: string; effects?: { status?: { success?: boolean; error?: unknown } } }
    | undefined;
  // gRPC `ExecutionStatus` is `{ success: true, error: null } | { success: false, error }`.
  if (txInner?.effects?.status && txInner.effects.status.success === false) {
    const errField = txInner.effects.status.error;
    const reason =
      (typeof errField === "string" && errField) ||
      (typeof errField === "object" &&
        errField !== null &&
        "message" in errField &&
        (errField as { message?: string }).message) ||
      "unknown failure";
    throw new Error(`transaction failed: ${reason}`);
  }

  const digest = txInner?.digest ?? (exec.digest as string | undefined) ?? "";
  // Object changes not requested on the include set here, keep parity
  // with the sponsored path's empty-array behavior. If the caller needs
  // created object ids it should poll `getTransaction(digest)` separately.
  return { digest, created: groupCreated(undefined) };
}

/**
 * Build a SUI transfer PTB. Includes a no-op MoveCall so the PTB is
 * sponsor-policy compatible (Onara's `targets: ["*"]` rejects pure-native
 * PTBs that contain no MoveCalls).
 */
export function buildSuiTransfer(opts: {
  amountMist: bigint;
  recipient: string;
}) {
  return (tx: Transaction) => {
    tx.moveCall({ target: "0x1::option::none", typeArguments: ["address"] });
    const [coin] = tx.splitCoins(tx.gas, [opts.amountMist]);
    tx.transferObjects([coin], opts.recipient);
  };
}

// Legacy USDC type, kept ONLY for the DeepBook USDC/SUI compat path in
// `buildCrossAssetSend` and for ecosystem auto-conversion. Day-to-day
// settlement is USDsui.
const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

// USDsui, the Sui-native USD stable. All user-facing send/payroll/invest
// flows settle in USDsui.
const USDSUI_COIN_TYPE =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

/**
 * Batch USDsui payroll: transfer to many recipients in one signed PTB.
 *
 * Each (recipient, amount) becomes a separate split + transfer leg. With
 * Sui's PTB limits we comfortably handle 50+ recipients in one tx.
 * Settlement is atomic, either everyone gets paid or no one does.
 */
export function buildBatchUsdsuiPayroll(opts: {
  senderAddress: string;
  recipients: { address: string; amountMicro: bigint; ref?: string }[];
}) {
  return async (tx: Transaction) => {
    const { coinWithBalance } = await import("@mysten/sui/transactions");
    for (const r of opts.recipients) {
      const coin = coinWithBalance({
        type: USDSUI_COIN_TYPE,
        balance: r.amountMicro,
      });
      tx.transferObjects([coin], r.address);
    }
  };
}

/**
 * THE BRIEF'S EXAMPLE #1: "A payment that automatically invests."
 *
 * A USDsui send that ALSO auto-supplies an extra slice to a DeepBook Spot
 * BalanceManager in the SAME signed PTB. Five Move calls, one signature:
 *
 *   1) split sender's USDsui into `payAmount` + `investAmount`
 *   2) transfer the pay leg to the recipient
 *   3) mint a fresh BalanceManager (owner = sender)
 *   4) deposit the invest leg into the BM
 *   5) share the BM so DeepBook can interact with it
 *
 * Programmable money: one tap pays a person and deploys idle capital.
 */
export function buildPayAndInvest(opts: {
  senderAddress: string;
  payAmountMicro: bigint;
  investAmountMicro: bigint;
  recipient: string;
}) {
  return async (tx: Transaction) => {
    const { coinWithBalance } = await import("@mysten/sui/transactions");
    const PKG = MAINNET_SPOT.packageId;

    // 1) Source coins (auto-merges available USDsui inputs via coinWithBalance)
    const payCoin = coinWithBalance({
      type: USDSUI_COIN_TYPE,
      balance: opts.payAmountMicro,
    });
    const investCoin = coinWithBalance({
      type: USDSUI_COIN_TYPE,
      balance: opts.investAmountMicro,
    });

    // 2) Pay the recipient
    tx.transferObjects([payCoin], opts.recipient);

    // 3) Mint a fresh BalanceManager
    const bm = tx.moveCall({
      target: `${PKG}::balance_manager::new`,
    });

    // 4) Deposit the invest leg into the BM
    tx.moveCall({
      target: `${PKG}::balance_manager::deposit`,
      typeArguments: [USDSUI_COIN_TYPE],
      arguments: [bm, investCoin],
    });

    // 5) Share the BM so future order-placement PTBs can interact with it
    tx.moveCall({
      target: "0x2::transfer::public_share_object",
      typeArguments: [`${PKG}::balance_manager::BalanceManager`],
      arguments: [bm],
    });
  };
}

// DeepBook V3 mainnet margin pool addresses (mirrors @mysten/deepbook-v3 constants).
const MAINNET_MARGIN = {
  packageId: "0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377",
  registryId: "0x0e40998b359a9ccbab22a98ed21bd4346abf19158bc7980c8291908086b3a742",
  pools: {
    USDC: {
      address: "0xba473d9ae278f10af75c50a8fa341e9c6a1c087dc91a3f23e8048baf67d0754f",
      type: USDC_COIN_TYPE,
      scalar: 1_000_000,
    },
    SUI: {
      address: "0x53041c6f86c4782aabbfc1d4fe234a6d37160310c7ee740c915f0a01b7127344",
      type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      scalar: 1_000_000_000,
    },
  },
} as const;

// DeepBook V3 mainnet spot constants used by buildCrossAssetSend.
const MAINNET_SPOT = {
  packageId: "0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e",
  // SUI is the base, USDC is the quote.
  pools: {
    SUI_USDC: "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407",
  },
  types: {
    SUI: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    USDC: USDC_COIN_TYPE,
    DEEP: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
  },
} as const;

/**
 * Build a USDsui transfer PTB.
 * Picks the sender's largest USDsui coin object, merges any additional ones
 * in if needed to cover the amount, splits off the exact amount, transfers.
 *
 * `amountMicro` is in microUSDsui (6 decimals).
 */
export function buildUsdsuiTransfer(opts: {
  senderAddress: string;
  amountMicro: bigint;
  recipient: string;
}) {
  return async (tx: Transaction) => {
    // No-op MoveCall so the PTB satisfies Onara's sponsor policy.
    tx.moveCall({ target: "0x1::option::none", typeArguments: ["address"] });
    const client = suiClient();
    // gRPC `listCoins` returns `{ objects: Coin[], hasNextPage, cursor }`.
    // Each Coin has `objectId`, `balance`, `type`, etc. Default limit is
    // 50, bumped to 200 here since one wallet may hold many small dust
    // coins after a NAVI withdraw and we want the merge to succeed.
    const coinsRes = await client.listCoins({
      owner: opts.senderAddress,
      coinType: USDSUI_COIN_TYPE,
      limit: 200,
    });
    const coins = (coinsRes.objects ?? []).slice().sort((a, b) =>
      BigInt(b.balance) - BigInt(a.balance) > 0n ? 1 : -1
    );
    if (coins.length === 0) {
      throw new Error("No USDsui in wallet. Fund the address first.");
    }
    const primary = tx.object(coins[0].objectId);
    if (coins.length > 1) {
      tx.mergeCoins(
        primary,
        coins.slice(1).map((c) => tx.object(c.objectId))
      );
    }
    const [out] = tx.splitCoins(primary, [opts.amountMicro]);
    tx.transferObjects([out], opts.recipient);
  };
}

/** Public helper for parsing base64 → Uint8Array (used in tests). */
export const _utils = { fromBase64, toBase64 };

/**
 * Cross-asset send via DeepBook Spot, the legacy USDC↔SUI on-chain
 * proof-of-swap path.
 *
 * NOTE: Cross-asset to USDsui goes through Cetus via the T2000 SDK; DeepBook
 * spot is kept for the USDC↔SUI compat path (the user-facing
 * `crossAssetIntent` already routes through T2000/Cetus per intents.ts, so
 * this DeepBook function is largely legacy and used only where we need
 * on-chain proof-of-swap on the deep SUI/USDC pool).
 *
 * Inside a single signed transaction:
 *   1) Pull `payAmount` of the source asset from the wallet
 *   2) Swap it on DeepBook Spot's SUI_USDC pool
 *   3) Transfer the output coin to `recipient`
 *   4) Return any leftover to `sender`
 *
 * Slippage: we pass minOut=0 for v1 because SUI/USDC is a deep pool. For
 * larger sizes the caller should derive minOut from a fresh on-chain quote.
 */
export function buildCrossAssetSend(opts: {
  senderAddress: string;
  payAsset: "USDC" | "SUI";
  receiveAsset: "USDC" | "SUI";
  /** Raw smallest-unit amount of the source asset (microUSDC or MIST). */
  payAmount: bigint;
  recipient: string;
}) {
  return async (tx: Transaction) => {
    if (opts.payAsset === opts.receiveAsset) {
      throw new Error(
        "Same-asset transfer, use buildSuiTransfer / buildUsdsuiTransfer."
      );
    }
    const { coinWithBalance } = await import("@mysten/sui/transactions");
    const { packageId, pools, types } = MAINNET_SPOT;
    const isUsdcIn = opts.payAsset === "USDC";

    // 1) Pull source asset coin
    const sourceCoin = isUsdcIn
      ? coinWithBalance({ type: types.USDC, balance: opts.payAmount })
      : tx.splitCoins(tx.gas, [opts.payAmount])[0];

    // 2) Empty DEEP coin, SUI/USDC pool is whitelisted on mainnet (input-fee mode),
    //    so no DEEP is consumed even though the Move signature requires the slot.
    const deepCoin = coinWithBalance({ type: types.DEEP, balance: 0n });

    // 3) Swap; returns (baseCoin, leftoverQuote, leftoverDeep)
    const target = isUsdcIn
      ? `${packageId}::pool::swap_exact_quote_for_base`
      : `${packageId}::pool::swap_exact_base_for_quote`;

    const result = tx.moveCall({
      target,
      typeArguments: [types.SUI, types.USDC],
      arguments: isUsdcIn
        ? [
            tx.object(pools.SUI_USDC),
            sourceCoin,
            deepCoin,
            tx.pure.u64(0n), // minBase (slippage off for v1)
            tx.object("0x6"),
          ]
        : [
            tx.object(pools.SUI_USDC),
            sourceCoin,
            deepCoin,
            tx.pure.u64(0n), // minQuote (slippage off for v1)
            tx.object("0x6"),
          ],
    });

    // base = SUI, quote = USDC (per pool definition)
    const baseOut = result[0];
    const quoteOut = result[1];
    const deepOut = result[2];

    // 4) Route output: recipient gets the asset they wanted.
    if (opts.receiveAsset === "SUI") {
      tx.transferObjects([baseOut], opts.recipient);
      // Anything left of the input goes back to sender
      tx.transferObjects([quoteOut], opts.senderAddress);
    } else {
      tx.transferObjects([quoteOut], opts.recipient);
      tx.transferObjects([baseOut], opts.senderAddress);
    }
    tx.transferObjects([deepOut], opts.senderAddress);
  };
}

/**
 * Build a DeepBook Spot LP deposit PTB.
 *
 *  1) `balance_manager::new`, mints a fresh BalanceManager with the caller
 *     as the cryptographic owner.
 *  2) `balance_manager::deposit<USDsui>`, funds the BM with the user's USDsui.
 *  3) `transfer::public_share_object`, shares the BM so future order-placement
 *     PTBs (and the pool itself) can interact with it. Only the owner can
 *     withdraw, so sharing is safe.
 *
 * `amountMicro` is in microUSDsui (6 decimals).
 *
 * NOTE: this is the legacy DeepBook path. The actual `spotLpIntent` already
 * routes through T2000's NAVI `save()` primitive, so this builder is unused
 * at runtime today, we keep it consistent with the USDsui rename for clarity.
 */
export function buildSpotLPDeposit(opts: {
  senderAddress: string;
  amountMicro: bigint;
}) {
  return async (tx: Transaction) => {
    const { coinWithBalance } = await import("@mysten/sui/transactions");
    const PKG = MAINNET_SPOT.packageId;

    // 1) Create BalanceManager (returned object reference, usable downstream)
    const bm = tx.moveCall({
      target: `${PKG}::balance_manager::new`,
    });

    // 2) Pull USDsui from the wallet and deposit into the BM
    const usdsuiIn = coinWithBalance({
      type: USDSUI_COIN_TYPE,
      balance: opts.amountMicro,
    });
    tx.moveCall({
      target: `${PKG}::balance_manager::deposit`,
      typeArguments: [USDSUI_COIN_TYPE],
      arguments: [bm, usdsuiIn],
    });

    // 3) Share the BM (consumes the local ref, BM goes shared)
    tx.moveCall({
      target: "0x2::transfer::public_share_object",
      typeArguments: [`${PKG}::balance_manager::BalanceManager`],
      arguments: [bm],
    });
  };
}

/**
 * Build a DeepBook Margin supply PTB.
 *
 *   1. mint a fresh SupplierCap
 *   2. pull `amountMicro` USDsui from the wallet via coinWithBalance
 *   3. supply it into the USDC margin pool against the new cap
 *   4. transfer the SupplierCap back to the user so they can withdraw later
 *
 * `amountMicro` is in microUSDsui (6 decimals).
 *
 * NOTE: T2000 owns this flow at runtime via NAVI `save()`, this builder is
 * kept consistent with the USDsui rename but is not the active codepath.
 * DeepBook margin pools today are USDC-typed, so the on-chain pool/type
 * config still references the legacy USDC pool object; we treat the user's
 * USDsui as the source-of-funds while keeping the DeepBook pool type stable.
 */
export function buildUsdsuiMarginSupply(opts: {
  senderAddress: string;
  amountMicro: bigint;
}) {
  return async (tx: Transaction) => {
    const pool = MAINNET_MARGIN.pools.USDC;

    // 1) mint supplier cap
    const cap = tx.moveCall({
      target: `${MAINNET_MARGIN.packageId}::margin_pool::mint_supplier_cap`,
      arguments: [
        tx.object(MAINNET_MARGIN.registryId),
        tx.object("0x6"), // shared Clock
      ],
    });

    // 2) pull exact USDsui from the wallet
    const { coinWithBalance } = await import("@mysten/sui/transactions");
    const supplyCoin = coinWithBalance({
      type: USDSUI_COIN_TYPE,
      balance: opts.amountMicro,
    });

    // 3) supply
    tx.moveCall({
      target: `${MAINNET_MARGIN.packageId}::margin_pool::supply`,
      typeArguments: [pool.type],
      arguments: [
        tx.object(pool.address),
        tx.object(MAINNET_MARGIN.registryId),
        cap,
        supplyCoin,
        // optional referral_id: pass an empty Option<ID>
        tx.moveCall({
          target: "0x1::option::none",
          typeArguments: ["0x2::object::ID"],
          arguments: [],
        }),
        tx.object("0x6"),
      ],
    });

    // 4) keep the cap (for withdraw later)
    tx.transferObjects([cap], opts.senderAddress);
  };
}
