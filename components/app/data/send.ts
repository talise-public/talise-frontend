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
 * Spend + Save needs NO extra step here. When round-up is on, the server puts
 * the NAVI supply leg inside the SAME PTB as the transfer and routes it to the
 * sponsored rail, so the one signature above covers both legs and the execute
 * response tells us what the save actually did.
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
 * What the Spend + Save leg actually did. Rendered verbatim by the receipt —
 * never the amount we hoped to save.
 *
 *   none     no save leg in this send (round-up off, or under the floor).
 *   saved    the supply is on chain and the savings total moved.
 *   pending  the send landed and the save is inside it, but the server could
 *            not read it back yet, so nothing is credited yet.
 *   failed   nothing was saved and the savings total did not move.
 */
export type RoundupSaveOutcome =
  | { status: "none"; reason?: string }
  | { status: "saved"; savedUsd: number }
  | { status: "pending"; savedUsd: 0 }
  | { status: "failed"; savedUsd: 0; message: string };

/**
 * What `send()` resolves with. `digest` is the on-chain receipt; `mode` and
 * `save` are the SERVER-BLESSED rail + Save decisions, surfaced so the success
 * UI can show what actually happened instead of fabricating steps.
 */
export type SendResult = {
  digest: string;
  /** "gasless" | "sponsored" | "sponsored-save" | "sponsored-*-fallback" */
  mode: string;
  /** Gross round-up the server put in the PTB (0 when there is no save leg). */
  roundupUsd: number;
  /** Truthful outcome of the save leg. */
  save: RoundupSaveOutcome;
};

/** The `save` block sponsor-prepare returns. */
type PrepareSave = {
  applied: boolean;
  grossUsd: number;
  netUsd: number;
  feeBps: number;
  venue: string;
  proof?: string;
  reason?: string;
};

type PrepareResponse = {
  bytes: string;
  mode: string;
  save?: PrepareSave;
  receiptNonce?: string;
};

type ExecuteResponse = {
  digest: string;
  freshProof?: Parameters<typeof writeCachedProof>[0];
  save?: { status: string; savedUsd?: number; reason?: string };
};

/**
 * Turn the server's prepare + execute responses into the one honest sentence
 * the receipt is allowed to say about the save.
 *
 * When execute comes back `pending`, the send landed and the save is inside it,
 * but the server could not read the transaction back in time to prove the
 * amount, so it credited nothing. We give it ONE re-confirm — a retried READ of
 * a transaction that already exists, with the server's own proof. It is not a
 * queue and there is no scheduled job behind it: if this call also comes back
 * pending, the tally simply doesn't move and we say "confirming", which is the
 * truth.
 */
async function resolveSave(
  prep: PrepareResponse,
  exec: ExecuteResponse
): Promise<RoundupSaveOutcome> {
  const applied = prep.save?.applied === true;
  if (!applied) {
    return { status: "none", ...(prep.save?.reason ? { reason: prep.save.reason } : {}) };
  }
  const status = exec.save?.status;
  if (status === "saved") {
    return { status: "saved", savedUsd: exec.save?.savedUsd ?? prep.save?.netUsd ?? 0 };
  }
  if (status === "failed") {
    return {
      status: "failed",
      savedUsd: 0,
      message: exec.save?.reason ?? "The round-up didn't go through.",
    };
  }
  // pending (or an older server that didn't report). Try once more.
  if (!prep.save?.proof || !exec.digest) return { status: "pending", savedUsd: 0 };
  try {
    const again = await api<{ status: string; savedUsd?: number; reason?: string }>(
      "/api/send/save-confirm",
      { method: "POST", body: { digest: exec.digest, saveProof: prep.save.proof } }
    );
    if (again.status === "saved") {
      return { status: "saved", savedUsd: again.savedUsd ?? prep.save.netUsd };
    }
    if (again.status === "failed") {
      return {
        status: "failed",
        savedUsd: 0,
        message: again.reason ?? "The round-up didn't go through.",
      };
    }
  } catch {
    /* the send already landed; a failed re-read is not a send failure */
  }
  return { status: "pending", savedUsd: 0 };
}

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
          meta: {
            receiptNonce: prep.receiptNonce,
            // The server's own HMAC-signed proof of the save leg it put in
            // these bytes. We only carry it; we cannot read or change what is
            // inside it, and it is the only thing that can move the tally.
            ...(prep.save?.proof ? { saveProof: prep.save.proof } : {}),
          },
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

      // Spend + Save: nothing to fire. The supply was a leg of the very
      // transaction we just signed, so all that's left is to report what the
      // server read back off chain.
      const save = await resolveSave(prep, exec);

      // Surface the server's rail + Save decisions alongside the digest; the
      // success UI derives its step list from these (never from client
      // guesses, and never from the amount we merely hoped to save).
      return {
        digest: exec.digest,
        mode: prep.mode,
        roundupUsd: prep.save?.applied ? prep.save.grossUsd : 0,
        save,
      };
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
