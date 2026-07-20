"use client";

/**
 * useSignAndSend, the browser send pipeline for plain USDsui / SUI transfers.
 *
 * Reuses the zkLogin ephemeral key that `web/lib/zkclient.ts` provisions in
 * sessionStorage. The server builds the sponsor-ready (or gasless) bytes, we
 * sign them with the ephemeral key, then the server wraps the zkLogin
 * signature + sponsor signature and broadcasts:
 *
 *   POST /api/send/sponsor-prepare {to, amount, asset}  -> { bytes, mode, ... }
 *   sign bytes with the ephemeral Ed25519 key
 *   if mode === "gasless":  POST /api/send/gasless-submit
 *   else (sponsored*):      POST /api/zk/sponsor-execute
 *   -> { digest }
 *
 * On success we dispatch a `talise:tx` window event so balance/activity hooks
 * refresh. If there's no ephemeral key (not signed in to the wallet), we kick
 * the Google sign-in flow and return to the current path.
 */

import { useCallback, useRef, useState } from "react";
import { forceFreshSignIn, isSessionExpiryError } from "@/lib/session-expiry";
import { fromBase64 } from "@mysten/sui/utils";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { triggerOauthSignIn, readEphemeralForT2000, writeCachedProof } from "@/lib/zkclient";
import { api, ApiError } from "./api";

export type SendArgs = {
  to: string;
  amountUsd: number;
  asset?: "USDsui" | "SUI";
};

/**
 * What `send()` resolves with. `digest` is the on-chain receipt; `mode` and
 * `roundupUsd` are the SERVER-BLESSED rail + round-up decisions from
 * sponsor-prepare, surfaced so the success UI can show what actually happened
 * (gasless vs sponsored, and the real Save leg) instead of fabricating steps.
 */
export type SendResult = {
  digest: string;
  /** "gasless" | "sponsored" | "sponsored-coin-fallback" | "sponsored-anchor-fallback" */
  mode: string;
  /** USD rounded up into NAVI as an atomic Save leg this send (0 when none). */
  roundupUsd: number;
};

type PrepareResponse = {
  bytes: string;
  mode: string;
  roundupUsd?: number;
  receiptNonce?: string;
};

type ExecuteResponse = {
  digest: string;
  freshProof?: Parameters<typeof writeCachedProof>[0];
};

export function useSignAndSend() {
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);

  const send = useCallback(async (args: SendArgs): Promise<SendResult> => {
    if (inFlight.current) {
      throw new ApiError(0, "A send is already in progress.", "BUSY");
    }

    const eph = readEphemeralForT2000();
    if (!eph) {
      // No wallet key in this tab, bounce through Google and come back here.
      triggerOauthSignIn({ returnTo: typeof location !== "undefined" ? location.pathname : "/app" });
      throw new ApiError(401, "Sign in to continue.", "NOT_SIGNED_IN");
    }

    inFlight.current = true;
    setSending(true);
    try {
      const asset = args.asset ?? "USDsui";

      // 1) Server builds the sponsor-ready (or gasless) TransactionData bytes.
      const prep = await api<PrepareResponse>("/api/send/sponsor-prepare", {
        method: "POST",
        body: { to: args.to, amount: args.amountUsd, asset },
      });

      // 2) Sign the full bytes with the ephemeral key (the sender signature).
      const keypair = Ed25519Keypair.fromSecretKey(eph.ephemeralPrivateKey);
      const { signature: userSignature } = await keypair.signTransaction(
        fromBase64(prep.bytes)
      );

      // 3) Server wraps the zkLogin signature (+ sponsor sig for the sponsored
      //    path) and broadcasts. Gasless mode goes through gasless-submit.
      const executePath =
        prep.mode === "gasless" ? "/api/send/gasless-submit" : "/api/zk/sponsor-execute";

      const exec = await api<ExecuteResponse>(executePath, {
        method: "POST",
        body: {
          bytesB64: prep.bytes,
          ephemeralPubKeyB64: eph.ephemeralPubKeyB64,
          maxEpoch: eph.maxEpoch,
          randomness: eph.randomness,
          userSignature,
          cachedProof: eph.cachedProof,
          meta: { roundupUsd: prep.roundupUsd, receiptNonce: prep.receiptNonce },
        },
      });

      // First successful tx this session returns a freshly-minted proof -
      // persist it so the next send skips the prover round trip.
      if (exec.freshProof) {
        try {
          writeCachedProof(exec.freshProof);
        } catch {
          /* non-fatal */
        }
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("talise:tx", { detail: { digest: exec.digest } }));
      }

      // Surface the server's rail + Save decisions from prepare alongside the
      // digest, the success UI derives its atomic-step list from these (never
      // from client guesses).
      return { digest: exec.digest, mode: prep.mode, roundupUsd: prep.roundupUsd ?? 0 };
    } catch (e) {
      // Expired signing session (server 401 / stale binding): tear down and
      // send the user straight back through Google so they can finish what
      // they started in a fresh session.
      if (isSessionExpiryError(e)) {
        void forceFreshSignIn({ reauthNow: true });
        throw new ApiError(401, "Your session expired, signing you in again…", "SESSION_EXPIRED");
      }
      throw e;
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }, []);

  return { send, sending };
}
