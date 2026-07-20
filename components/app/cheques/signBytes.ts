"use client";

/**
 * signSponsorReadyBytes, sign server-built sponsor-ready TransactionData bytes
 * with the zkLogin ephemeral key and broadcast via /api/zk/sponsor-execute.
 *
 * The plain-send pipeline lives in `useSignAndSend`, but cheques and streams
 * also fund / reclaim / cancel over the ON-CHAIN rail, where the server hands
 * back ready-to-sign `bytes` (e.g. `cheque::create`, `cheque::reclaim`,
 * `stream::create`, `stream::cancel_and_withdraw`). This is the equivalent of
 * the iOS `executeSponsorReady(bytesB64:)` helper: sign the bytes with the
 * ephemeral Ed25519 key, POST to /api/zk/sponsor-execute, return the digest.
 *
 * On success it persists any freshly-minted proof (so the next sign skips the
 * prover) and dispatches the `talise:tx` window event so balances/activity
 * refresh.
 */

import { fromBase64 } from "@mysten/sui/utils";
import { forceFreshSignIn, isSessionExpiryError } from "@/lib/session-expiry";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  triggerOauthSignIn,
  readEphemeralForT2000,
  writeCachedProof,
} from "@/lib/zkclient";
import { api, ApiError } from "@/components/app/data";

type ExecuteResponse = {
  digest: string;
  freshProof?: Parameters<typeof writeCachedProof>[0];
};

/**
 * Sign + execute sponsor-ready bytes. If there's no ephemeral key in this tab
 * (not signed in to the wallet), kicks the Google flow and throws NOT_SIGNED_IN.
 */
export async function signSponsorReadyBytes(
  bytesB64: string,
  meta?: Record<string, unknown>
): Promise<{ digest: string }> {
  const eph = readEphemeralForT2000();
  if (!eph) {
    triggerOauthSignIn({
      returnTo: typeof location !== "undefined" ? location.pathname : "/app",
    });
    throw new ApiError(401, "Sign in to continue.", "NOT_SIGNED_IN");
  }

  const keypair = Ed25519Keypair.fromSecretKey(eph.ephemeralPrivateKey);
  const { signature: userSignature } = await keypair.signTransaction(
    fromBase64(bytesB64)
  );

  let exec: ExecuteResponse;
  try {
    exec = await api<ExecuteResponse>("/api/zk/sponsor-execute", {
      method: "POST",
      body: {
        bytesB64,
        ephemeralPubKeyB64: eph.ephemeralPubKeyB64,
        maxEpoch: eph.maxEpoch,
        randomness: eph.randomness,
        userSignature,
        cachedProof: eph.cachedProof,
        meta,
      },
    });
  } catch (e) {
    // Expired signing session: tear down + re-auth through Google.
    if (isSessionExpiryError(e)) {
      void forceFreshSignIn({ reauthNow: true });
      throw new ApiError(401, "Your session expired, signing you in again…", "SESSION_EXPIRED");
    }
    throw e;
  }

  if (exec.freshProof) {
    try {
      writeCachedProof(exec.freshProof);
    } catch {
      /* non-fatal */
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("talise:tx", { detail: { digest: exec.digest } })
    );
  }

  return { digest: exec.digest };
}

/** Friendly inline error text for cheque/stream API failures. */
export function friendlyError(
  e: unknown,
  fallback: string,
  rolloutSubject?: string
): string {
  if (e instanceof ApiError) {
    const code = e.status;
    const msg = e.message ?? "";
    const lower = msg.toLowerCase();
    const rollout =
      code === 404 ||
      code === 503 ||
      lower.includes("not configured") ||
      lower.includes("disabled") ||
      lower.includes("not found") ||
      lower.includes("unavailable");
    if (rollout && rolloutSubject) {
      return `${rolloutSubject} are rolling out, check back soon.`;
    }
    if (code === 429) {
      return "You're going a little fast, give it a minute and try again.";
    }
    if (e.code === "NOT_SIGNED_IN") {
      return "Taking you to sign in…";
    }
    if (msg) return msg;
  }
  return fallback;
}
