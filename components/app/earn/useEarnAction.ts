"use client";

/**
 * useEarnAction, the browser signer for Earn (invest / withdraw) flows.
 *
 * Plain sends go through `useSignAndSend` (server returns ready-to-sign
 * TransactionData bytes). The Earn /prepare routes are different: they return
 * a `transactionKindB64` (the transaction KIND only, no gas data). So the
 * pipeline here has one extra hop:
 *
 *   POST /api/earn/<supply|withdraw|withdraw-earned>/prepare {venue, amount?}
 *        -> { transactionKindB64 }
 *   POST /api/zk/sponsor {transactionKindB64}
 *        -> { bytes }                     (sponsor attaches gas data)
 *   sign `bytes` with the sessionStorage ephemeral Ed25519 key
 *   POST /api/zk/sponsor-execute {bytesB64, ephemeralPubKeyB64, maxEpoch,
 *        randomness, userSignature, cachedProof?, meta:{kind}}
 *        -> { digest, freshProof? }
 *
 * It reuses the exact same ephemeral key / cached-proof plumbing as
 * `useSignAndSend` (readEphemeralForT2000 / writeCachedProof from zkclient) -
 * no proof logic is duplicated here. On success it dispatches the global
 * `talise:tx` window event so balances/activity auto-refresh, and returns the
 * digest. If the wallet key isn't present we kick the Google sign-in flow.
 */

import { useCallback, useRef, useState } from "react";
import { forceFreshSignIn, isSessionExpiryError } from "@/lib/session-expiry";
import { fromBase64 } from "@mysten/sui/utils";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  triggerOauthSignIn,
  readEphemeralForT2000,
  writeCachedProof,
} from "@/lib/zkclient";
import { api, ApiError } from "@/components/app";

export type EarnVenue = "navi" | "deepbook";

type PrepareKind =
  | { op: "supply"; venue: EarnVenue; amountUsd: number }
  | { op: "withdraw"; venue: EarnVenue; amountUsd?: number }
  | { op: "withdrawEarned"; venue: "navi" };

type PrepareResponse = {
  transactionKindB64: string;
  venue?: string;
  amount?: number | null;
  earned?: number;
  receiptNonce?: string;
};

type SponsorResponse = { bytes: string; digest?: string };

type ExecuteResponse = {
  digest: string;
  freshProof?: Parameters<typeof writeCachedProof>[0];
};

const PREPARE_PATH: Record<PrepareKind["op"], string> = {
  supply: "/api/earn/supply/prepare",
  withdraw: "/api/earn/withdraw/prepare",
  withdrawEarned: "/api/earn/withdraw-earned/prepare",
};

export function useEarnAction() {
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(
    async (action: PrepareKind): Promise<{ digest: string }> => {
      if (inFlight.current) {
        throw new ApiError(0, "Another earn action is already in progress.", "BUSY");
      }

      const eph = readEphemeralForT2000();
      if (!eph) {
        triggerOauthSignIn({
          returnTo: typeof location !== "undefined" ? location.pathname : "/app/earn",
        });
        throw new ApiError(401, "Sign in to continue.", "NOT_SIGNED_IN");
      }

      inFlight.current = true;
      setWorking(true);
      try {
        // 1) Prepare, server builds the transaction KIND for the venue leg.
        const prepareBody =
          action.op === "supply"
            ? { venue: action.venue, amount: action.amountUsd }
            : action.op === "withdraw"
              ? { venue: action.venue, amount: action.amountUsd ?? null }
              : { venue: "navi" };

        const prep = await api<PrepareResponse>(PREPARE_PATH[action.op], {
          method: "POST",
          body: prepareBody,
        });

        // 2) Sponsor, wrap the kind in full TransactionData with gas data.
        const sponsor = await api<SponsorResponse>("/api/zk/sponsor", {
          method: "POST",
          body: { transactionKindB64: prep.transactionKindB64 },
        });

        // 3) Sign the sponsored bytes with the ephemeral key (sender sig).
        const keypair = Ed25519Keypair.fromSecretKey(eph.ephemeralPrivateKey);
        const { signature: userSignature } = await keypair.signTransaction(
          fromBase64(sponsor.bytes)
        );

        // 4) Execute, server wraps the zkLogin sig + sponsor sig, broadcasts.
        const metaKind = action.op === "supply" ? "invest" : "withdraw";
        const exec = await api<ExecuteResponse>("/api/zk/sponsor-execute", {
          method: "POST",
          body: {
            bytesB64: sponsor.bytes,
            ephemeralPubKeyB64: eph.ephemeralPubKeyB64,
            maxEpoch: eph.maxEpoch,
            randomness: eph.randomness,
            userSignature,
            cachedProof: eph.cachedProof,
            meta: {
              kind: metaKind,
              venue: prep.venue ?? (action.op === "withdrawEarned" ? "navi" : action.venue),
              receiptNonce: prep.receiptNonce,
            },
          },
        });

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
      } catch (e) {
        if (isSessionExpiryError(e)) {
          void forceFreshSignIn({ reauthNow: true });
          throw new ApiError(401, "Your session expired, signing you in again…", "SESSION_EXPIRED");
        }
        throw e;
      } finally {
        inFlight.current = false;
        setWorking(false);
      }
    },
    []
  );

  const supply = useCallback(
    (venue: EarnVenue, amountUsd: number) => run({ op: "supply", venue, amountUsd }),
    [run]
  );
  const withdraw = useCallback(
    (venue: EarnVenue, amountUsd?: number) => run({ op: "withdraw", venue, amountUsd }),
    [run]
  );
  const withdrawEarned = useCallback(
    () => run({ op: "withdrawEarned", venue: "navi" }),
    [run]
  );

  return { supply, withdraw, withdrawEarned, working };
}
