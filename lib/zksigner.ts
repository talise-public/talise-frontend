/**
 * Server-side zkLogin signing helpers.
 *
 *  - Stores the JWT + salt in an encrypted httpOnly cookie alongside the
 *    session cookie (so we can re-use the JWT for proof generation later).
 *  - Talks to the Mysten prover service.
 *  - Wraps the proof + ephemeral signature into a final zkLoginSignature.
 *
 * Never expose these helpers to the client bundle — they import server-only
 * crypto via @mysten/sui's zklogin tree.
 */

import "server-only";
import { cookies } from "next/headers";
import {
  genAddressSeed,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
} from "@mysten/sui/zklogin";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { sign, verify } from "./auth";
import { decodeJwt } from "./zklogin";
import { shinamiCreateProof, shinamiEnabled } from "./shinami";

const JWT_COOKIE = "talise_jwt";

/** Cookie Domain attribute. Set COOKIE_DOMAIN=.talise.io in production so the
 *  signing cookie travels with the session across www.talise.io and
 *  app.talise.io. Unset locally and on previews. */
function cookieDomain(): string | undefined {
  const d = process.env.COOKIE_DOMAIN?.trim();
  return d || undefined;
}

/**
 * Prover endpoint resolution order:
 *   1. ZK_PROVER_URL env (our self-hosted prover — required for mainnet
 *      since Mysten's hosted mainnet prover whitelists audiences).
 *   2. Mysten's testnet prover (open to all audiences) on testnet.
 *   3. Mysten's mainnet prover as a last resort on mainnet (only works for
 *      whitelisted audiences).
 *
 * NOTE: This URL is used by the LEGACY single-call `callProver()` path. The
 * preferred entry point is `callProverWithFallback()` (below) which honours
 * `ZK_PROVER_PRIMARY` + `ZK_PROVER_GPU_URL` and falls back to either Shinami
 * or the legacy Mysten URL on 5xx/timeout.
 */
const PROVER_URL = (() => {
  const override = process.env.ZK_PROVER_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const net = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet").toLowerCase();
  return net === "testnet"
    ? "https://prover-dev.mystenlabs.com/v1"
    : "https://prover.mystenlabs.com/v1";
})();

/**
 * Runtime toggle for which prover backend wins.
 *
 *   ZK_PROVER_PRIMARY     - "gpu" | "shinami" | "mysten"   (default "shinami")
 *   ZK_PROVER_GPU_URL     - https URL of our unconfirmedlabs GPU prover
 *   ZK_PROVER_FALLBACK    - "gpu" | "shinami" | "mysten" | "none" (default "shinami")
 *   ZK_PROVER_CANARY_PCT  - 0..100 (default 0). When >0 a deterministic bucket
 *                           of users gets routed to GPU regardless of PRIMARY,
 *                           the rest fall through to PRIMARY.
 *   ZK_PROVER_TIMEOUT_MS  - per-attempt timeout (default 8000ms — generous
 *                           enough for the GPU cold-load on the first call).
 *
 * We keep `shinami` as the default primary so this ships safely. Flip
 * `ZK_PROVER_PRIMARY=gpu` once the GPU box is healthy.
 */
type ProverBackend = "gpu" | "shinami" | "mysten";

function readBackend(name: string, fallback: ProverBackend | "none"): ProverBackend | "none" {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "gpu" || raw === "shinami" || raw === "mysten" || raw === "none") return raw;
  return fallback;
}

const PRIMARY_BACKEND: ProverBackend = (() => {
  const b = readBackend("ZK_PROVER_PRIMARY", "shinami");
  return b === "none" ? "shinami" : b;
})();

const FALLBACK_BACKEND: ProverBackend | "none" = readBackend(
  "ZK_PROVER_FALLBACK",
  "shinami"
);

const GPU_URL = (() => {
  const u = process.env.ZK_PROVER_GPU_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
})();

const CANARY_PCT = (() => {
  const raw = process.env.ZK_PROVER_CANARY_PCT?.trim();
  if (!raw) return 0;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
})();

const PROVER_TIMEOUT_MS = (() => {
  const raw = process.env.ZK_PROVER_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

/** FNV-1a 32-bit hash → stable bucket 0..99 from any utf-8 string. */
function bucket0_99(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h % 100;
}

/** Persist the JWT + salt in an encrypted cookie. ~1 hour TTL (matches Google JWT). */
export async function setSigningCookie(jwt: string, salt: string) {
  const jar = await cookies();
  const payload = Buffer.from(JSON.stringify({ jwt, salt }), "utf8").toString("base64url");
  jar.set(JWT_COOKIE, sign(payload), {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60, // 1 hour
  });
}

export async function clearSigningCookie() {
  const jar = await cookies();
  jar.delete({ name: JWT_COOKIE, domain: cookieDomain(), path: "/" });
}

export async function readSigningCookie(): Promise<{ jwt: string; salt: string } | null> {
  const jar = await cookies();
  const raw = jar.get(JWT_COOKIE)?.value;
  if (!raw) return null;
  const payload = verify(raw);
  if (!payload) return null;
  try {
    const { jwt, salt } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    if (typeof jwt !== "string" || typeof salt !== "string") return null;
    return { jwt, salt };
  } catch {
    return null;
  }
}

export type ProverInputs = {
  jwt: string;
  extendedEphemeralPublicKey: string;
  maxEpoch: number;
  jwtRandomness: string;
  salt: string;
  keyClaimName: "sub" | "email";
};

type ProverResponse = {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
};

export async function callProver(
  inputs: ProverInputs,
  opts?: { url?: string; timeoutMs?: number; label?: string }
): Promise<ProverResponse> {
  const url = (opts?.url ?? PROVER_URL).replace(/\/+$/, "");
  const timeoutMs = opts?.timeoutMs ?? PROVER_TIMEOUT_MS;
  const label = opts?.label ?? "mysten";
  // P1-6: GPU prover endpoint sits behind a bearer token. If the
  // env var is set we attach it on every call. Public provers
  // (Mysten / Shinami) ignore unknown auth headers, so this is
  // safe to send unconditionally when the token is configured.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const authToken = process.env.ZK_PROVER_AUTH_TOKEN;
  if (authToken && authToken.length > 0) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(inputs),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`prover ${r.status} (${label}): ${text.slice(0, 200)}`);
    // Tag 5xx so the fallback wrapper can decide whether to retry.
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  // Tolerate snake_case responses from third-party provers (e.g. some GPU
  // builds). Mysten/Shinami return the camelCase shape natively, so this
  // normalize is a no-op for them.
  const raw = (await r.json()) as Record<string, unknown>;
  return normalizeProverResponse(raw);
}

function normalizeProverResponse(raw: Record<string, unknown>): ProverResponse {
  const proofPoints =
    (raw.proofPoints as ProverResponse["proofPoints"] | undefined) ??
    (raw.proof_points as ProverResponse["proofPoints"] | undefined);
  const issBase64Details =
    (raw.issBase64Details as ProverResponse["issBase64Details"] | undefined) ??
    (raw.iss_base64_details as ProverResponse["issBase64Details"] | undefined);
  const headerBase64 =
    (raw.headerBase64 as string | undefined) ??
    (raw.header_base64 as string | undefined);
  if (!proofPoints || !issBase64Details || !headerBase64) {
    throw new Error(
      `prover response missing fields (got keys: ${Object.keys(raw).join(",")})`
    );
  }
  return { proofPoints, issBase64Details, headerBase64 };
}

type WithFallbackOpts = {
  inputs: ProverInputs;
  /** Used by canary bucketing — stable per-user (address seed or salt-sub). */
  canaryKey?: string;
};

/**
 * Last prover backend + role that produced a successful proof in this
 * process. Surfaced by `callProverWithFallback` and propagated up to
 * `mintZkProof` so the execute handler can log the source ("FRESH-GPU"
 * vs "FRESH-SHINAMI" vs "FRESH-CANARY"). Production rollout signal: if
 * we see "FRESH-SHINAMI" on every call after `ZK_PROVER_PRIMARY=gpu` is
 * flipped, the GPU box is down and we're paying the 2–4s Shinami round
 * trip instead of the 250–500ms GPU path.
 */
export type ProverSource = {
  backend: ProverBackend;
  role: "primary" | "fallback";
  /** True iff canary bucketing routed this user to GPU regardless of PRIMARY. */
  canary: boolean;
  /** Wall-clock ms of the winning attempt (excludes earlier failed attempts). */
  ms: number;
};

/**
 * Unified entry-point that respects ZK_PROVER_PRIMARY / ZK_PROVER_FALLBACK /
 * ZK_PROVER_CANARY_PCT. Success path: primary returns 200 → done. 5xx or
 * timeout (AbortError): try the configured fallback once, then throw.
 *
 * Per-attempt structured log line:
 *   [zk-prover] role=primary backend=gpu attempt=1 status=200 ms=412
 *   [zk-prover] role=fallback backend=shinami attempt=2 status=200 ms=2740
 *
 * Visible in Vercel logs as `[zk-prover] ...` and intentionally low-cardinality
 * so we can grep cleanly during cutover.
 */
export async function callProverWithFallback(
  opts: WithFallbackOpts
): Promise<{ response: ProverResponse; source: ProverSource }> {
  // Product directive (2026-05-29 evening): "just use my Shinami". Hard-pin
  // the prover backend to Shinami here so neither the env nor the canary
  // bucket can route a user to GPU/Mysten. Keeps the env vars in place for
  // future re-rollouts but ignores them today.
  //
  // The canary code below is intentionally dead-on-purpose. To re-enable
  // GPU routing later, swap these two lines back to PRIMARY_BACKEND +
  // FALLBACK_BACKEND.
  const primary: ProverBackend = "shinami";
  const canary = false;
  void CANARY_PCT;
  void GPU_URL;
  void opts.canaryKey;
  void bucket0_99;
  void PRIMARY_BACKEND;

  const order: ProverBackend[] = [primary];
  if (FALLBACK_BACKEND !== "none" && FALLBACK_BACKEND !== primary) {
    order.push(FALLBACK_BACKEND);
  }

  let attempt = 0;
  let lastErr: unknown = null;
  for (let i = 0; i < order.length; i++) {
    attempt++;
    const backend = order[i];
    const role = i === 0 ? "primary" : "fallback";
    const start = Date.now();
    try {
      const out = await invokeBackend(backend, opts.inputs);
      const ms = Date.now() - start;
      console.log(
        `[zk-prover] role=${role} backend=${backend} attempt=${attempt} status=200 ms=${ms}`
      );
      return {
        response: out,
        source: { backend, role, canary: canary && i === 0, ms },
      };
    } catch (err) {
      const ms = Date.now() - start;
      const status = (err as { status?: number }).status;
      const isTimeout =
        (err as { name?: string }).name === "TimeoutError" ||
        (err as { name?: string }).name === "AbortError";
      const retryable = isTimeout || (typeof status === "number" && status >= 500);
      console.log(
        `[zk-prover] role=${role} backend=${backend} attempt=${attempt} status=${
          status ?? (isTimeout ? "timeout" : "err")
        } ms=${ms} msg=${truncate(String((err as Error).message ?? err), 160)}`
      );
      lastErr = err;
      if (!retryable && i === 0) {
        // Non-retryable primary failure (e.g. 4xx — bad JWT). Still fall
        // through to the fallback once so an upstream auth-flake on one
        // provider doesn't break the whole signing path; provider quirks
        // sometimes surface as 4xx on one and 200 on the other.
      }
    }
  }
  throw lastErr ?? new Error("all provers failed");
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function invokeBackend(
  backend: ProverBackend,
  inputs: ProverInputs
): Promise<ProverResponse> {
  if (backend === "gpu") {
    if (!GPU_URL) {
      throw new Error("ZK_PROVER_GPU_URL not set (backend=gpu requires it)");
    }
    return callProver(inputs, { url: GPU_URL, label: "gpu" });
  }
  if (backend === "shinami") {
    if (!shinamiEnabled()) {
      throw new Error("SHINAMI_API_KEY not set (backend=shinami requires it)");
    }
    const raw = await shinamiCreateProof({
      jwt: inputs.jwt,
      maxEpoch: inputs.maxEpoch,
      extendedEphemeralPublicKey: inputs.extendedEphemeralPublicKey,
      jwtRandomness: inputs.jwtRandomness,
      salt: inputs.salt,
    });
    return raw;
  }
  // backend === "mysten" — use the legacy PROVER_URL resolution.
  return callProver(inputs, { url: PROVER_URL, label: "mysten" });
}

/**
 * Full zkLogin proof, including the locally-computed `addressSeed`. This is
 * the cacheable artifact — it's valid for the entire ephemeral session
 * (~55 min in the browser, up to `maxEpoch` on chain). Pass it back through
 * later signing calls to skip the 2-4s Shinami round trip.
 */
export type CachedZkProof = {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
};

/**
 * Generate a fresh zkLogin proof via the configured prover. Reads the
 * session JWT + salt from the encrypted cookie. The returned object is the
 * cacheable shape — pass it to `assembleZkLoginSignature` on subsequent
 * sends to skip the prover call entirely.
 */
export async function mintZkProof(opts: {
  ephemeralPubKeyB64: string;
  maxEpoch: number;
  randomness: string;
  /** Mobile callers (no cookie) pass these directly. */
  jwt?: string;
  salt?: string;
}): Promise<{ proof: CachedZkProof; source: ProverSource }> {
  let jwt: string;
  let salt: string;
  if (opts.jwt && opts.salt) {
    jwt = opts.jwt;
    salt = opts.salt;
  } else {
    const stored = await readSigningCookie();
    if (!stored) throw new Error("No active sign-in. Please sign in again.");
    jwt = stored.jwt;
    salt = stored.salt;
  }

  const pubKey = new Ed25519PublicKey(fromBase64(opts.ephemeralPubKeyB64));
  const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(pubKey);

  // Compute addressSeed up-front so we can use it as the deterministic canary
  // bucketing key (stable per-user regardless of session).
  const claims = decodeJwt(jwt);
  const addressSeed = genAddressSeed(
    BigInt(salt),
    "sub",
    claims.sub,
    claims.aud
  ).toString();

  const { response: raw, source } = await callProverWithFallback({
    inputs: {
      jwt,
      extendedEphemeralPublicKey,
      maxEpoch: opts.maxEpoch,
      jwtRandomness: opts.randomness,
      salt,
      keyClaimName: "sub",
    },
    canaryKey: addressSeed,
  });

  return { proof: { ...raw, addressSeed }, source };
}

/**
 * Given the ephemeral signature of tx bytes, produce a full zkLoginSignature.
 * Returns the signature AND the proof used (whether cached or freshly minted)
 * so callers can persist it for the next send.
 *
 * The proof is `mintZkProof`'s biggest cost — Shinami's Groth16 generator
 * runs 2-4s. Pass `cachedProof` to skip that hop entirely.
 */
export async function assembleZkLoginSignature(opts: {
  ephemeralPubKeyB64: string;
  maxEpoch: number;
  randomness: string;
  userSignature: string;
  cachedProof?: CachedZkProof;
  /** Mobile callers (no cookie) pass these directly. */
  jwt?: string;
  salt?: string;
}): Promise<{
  signature: string;
  proof: CachedZkProof;
  isFresh: boolean;
  /** Populated only when `isFresh === true`. Undefined on cache hit. */
  source?: ProverSource;
}> {
  let proof: CachedZkProof;
  let isFresh = false;
  let source: ProverSource | undefined;
  if (opts.cachedProof) {
    proof = opts.cachedProof;
  } else {
    const minted = await mintZkProof({
      ephemeralPubKeyB64: opts.ephemeralPubKeyB64,
      maxEpoch: opts.maxEpoch,
      randomness: opts.randomness,
      jwt: opts.jwt,
      salt: opts.salt,
    });
    proof = minted.proof;
    source = minted.source;
    isFresh = true;
  }

  const signature = getZkLoginSignature({
    inputs: proof,
    maxEpoch: opts.maxEpoch,
    userSignature: opts.userSignature,
  });

  return { signature, proof, isFresh, source };
}

/**
 * Cold-start TLS pre-warm. The first fetch to Shinami/GPU from a fresh
 * lambda eats ~150-300ms on the TLS+HTTP/2 handshake; that's pure dead
 * time on the user's first send. Firing a cheap HEAD/GET at module load
 * primes the connection pool so the first real proof mint reuses an
 * already-open socket.
 *
 * Fire-and-forget. Failures are silent — this is best-effort warmth, not
 * a health check. The Node runtime keeps the socket alive on the HTTP
 * agent for ~5 minutes which covers all but the coldest Vercel cold
 * starts.
 */
function prewarmProverConnections(): void {
  // Mysten / Shinami: hit the resolved PROVER_URL host. We don't care
  // about the response — we just want the TCP+TLS+HTTP/2 round trip done.
  try {
    const u = new URL(PROVER_URL);
    void fetch(`${u.origin}/`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  } catch {
    // Malformed URL — ignore. Real calls will fail loudly with the
    // actual error.
  }
  // GPU prover, when configured. Same logic.
  if (GPU_URL) {
    try {
      const u = new URL(GPU_URL);
      void fetch(`${u.origin}/`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

prewarmProverConnections();
