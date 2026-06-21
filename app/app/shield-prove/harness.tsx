"use client";

import { useEffect } from "react";
import { deriveShieldKeypairFromSeed } from "@/lib/shield/sdk";
import {
  proveShieldDeposit,
  shieldWithdraw,
  spendExistingNote,
  spendOrTransferToShield,
  sweepShieldedBalance,
  shieldedBalanceMicros,
  type ShieldFlowConfig,
  type FlowInputNote,
} from "@/lib/shield/sdk/flow";
import { deriveShieldEncScalar } from "@/lib/shield/sdk/keys";
import { encPublicKeyFromScalar } from "@/lib/shield/sdk/encrypt";

/**
 * Client harness for the native private-send bridge. Installs
 * `window.taliseShieldSend` and posts structured messages to the native host:
 *   { type: "progress", message }      — status line while working
 *   { type: "signDeposit", bytesB64 }  — ask native to zkLogin-sign the deposit
 *   { type: "result", digest }         — success (the withdraw digest)
 *   { type: "error", message }         — clean, user-facing failure
 *
 * Native answers the signDeposit request by calling
 * `window.__taliseDepositSigned(digest, errorMessage)` (one is non-empty).
 *
 * FLOW (a shielded send is two legs with two signers):
 *   1. derive the user's non-custodial shield key (seed never leaves the device)
 *   2. fetch the live pool root + PROVE the deposit in-page (note secrets stay client-side)
 *   3. POST proof → /api/shield/deposit/prepare → sponsor-ready DEPOSIT PTB bytes
 *   4. hand bytes to NATIVE → zkLogin-sign + Onara gas + submit → deposit digest
 *   5. wait for the deposit commitment to index (its leaf enters the tree)
 *   6. PROVE + relay the WITHDRAW to the recipient (relayer-signed → severs the link)
 *
 * If the in-app feature flag is off the prepare route 503s and we report the
 * honest "finalizing" status — never faking a success, never stranding funds.
 */
type Msg =
  | { type: "progress"; message: string }
  | { type: "signDeposit"; bytesB64: string }
  | { type: "result"; digest: string }
  | { type: "error"; message: string };

declare global {
  interface Window {
    // `recipientShieldJson` (optional): JSON `{ pubkey, encPubkeyHex }` of the
    // recipient's published shield identity. When present + the sender holds a
    // covering note, the send becomes a HIDDEN-AMOUNT shielded transfer.
    taliseShieldSend?: (micros: string, recipient: string, seedHex: string, recipientShieldJson?: string) => void;
    taliseShieldRecover?: (seedHex: string, destination: string) => void;
    // Reports the shielded balance back via { type:"result", digest:"<micros>" }.
    taliseShieldBalance?: (seedHex: string) => void;
    __taliseDepositSigned?: (digest: string, error: string) => void;
    webkit?: { messageHandlers?: { shield?: { postMessage: (m: Msg) => void } } };
  }
}

const toHexBytes = (b: Uint8Array) =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex: string): Uint8Array => {
  const s = hex.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function seedFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function ShieldProveHarness({
  live,
  packageId,
  poolObjectId,
  coinType,
}: {
  live: boolean;
  packageId: string;
  poolObjectId: string;
  coinType: string;
}) {
  useEffect(() => {
    const post = (m: Msg) => {
      try {
        window.webkit?.messageHandlers?.shield?.postMessage(m);
      } catch {
        /* not in the native host */
      }
      // eslint-disable-next-line no-console
      console.log("[shield-prove]", m.type);
    };

    // Resolver for the native deposit-signing round-trip (step 4).
    let depositResolver: ((r: { digest?: string; error?: string }) => void) | null = null;
    window.__taliseDepositSigned = (digest: string, error: string) => {
      const r = depositResolver;
      depositResolver = null;
      r?.({ digest: digest || undefined, error: error || undefined });
    };

    /** Post the sponsor-ready bytes to native and await its zkLogin signature + submit. */
    const signDepositNative = (bytesB64: string) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (depositResolver) {
            depositResolver = null;
            reject(new Error("Signing timed out on this device."));
          }
        }, 90_000);
        depositResolver = ({ digest, error }) => {
          clearTimeout(timer);
          if (digest) resolve(digest);
          else reject(new Error(error || "Couldn’t sign the deposit on this device."));
        };
        post({ type: "signDeposit", bytesB64 });
      });

    const cfg: ShieldFlowConfig = {
      packageId,
      poolObjectId,
      coinType,
      // Same-origin requests carry the web-session cookie automatically.
      fetchInit: { credentials: "same-origin" },
    };

    /** POST helper that surfaces a structured error (never a raw HTML body). */
    const postJson = async (path: string, body: unknown) => {
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let j: Record<string, unknown> = {};
      try {
        j = await res.json();
      } catch {
        /* non-JSON */
      }
      return { ok: res.ok, status: res.status, body: j };
    };

    // Publish this user's PUBLIC shield identity (pubkey + enc pubkey) so others
    // can address hidden-amount transfers to them. Best-effort, idempotent.
    const ensureIdentityPublished = async (kp: Awaited<ReturnType<typeof deriveShieldKeypairFromSeed>>) => {
      try {
        const d = await deriveShieldEncScalar(kp.spendingKey);
        const encPubkeyHex = toHexBytes(encPublicKeyFromScalar(d));
        await postJson("/api/shield/identity", { pubkey: kp.publicKey.toString(), encPubkeyHex });
      } catch {
        /* best-effort — never blocks a send */
      }
    };

    window.taliseShieldSend = (
      micros: string,
      recipient: string,
      seedHex: string,
      recipientShieldJson?: string
    ) => {
      void (async () => {
        try {
          post({ type: "progress", message: "Preparing your private send…" });

          if (!live || !packageId || !poolObjectId) {
            throw new Error("Private send isn’t switched on yet.");
          }
          // Require a CANONICAL full 32-byte address. Short/non-padded forms are
          // rejected (never auto-padded) so the unshielded funds can't land at an
          // unintended address — the withdraw is relayer-signed + irreversible.
          if (!/^0x[a-f0-9]{64}$/i.test(recipient)) throw new Error("Invalid recipient address.");
          const amount = BigInt(micros);
          if (amount <= 0n) throw new Error("Enter an amount.");
          if (!/^[0-9a-f]{32,128}$/i.test(seedHex)) {
            throw new Error("Couldn’t unlock your private key on this device.");
          }

          // 1. Derive the NON-CUSTODIAL shield keypair on-device (seed never leaves).
          post({ type: "progress", message: "Unlocking your private key…" });
          const keypair = await deriveShieldKeypairFromSeed(seedFromHex(seedHex));
          if (keypair.spendingKey <= 0n) throw new Error("Key derivation failed.");
          void ensureIdentityPublished(keypair); // become addressable for future transfers

          // Parse the recipient's published shield identity (if any) → enables a
          // hidden-amount shielded transfer instead of a public withdraw.
          let recipientShield: { pubkey: bigint; encKey: Uint8Array } | null = null;
          try {
            if (recipientShieldJson) {
              const r = JSON.parse(recipientShieldJson) as { pubkey?: string; encPubkeyHex?: string };
              if (r?.pubkey && /^0x04[0-9a-f]{128}$/i.test(r.encPubkeyHex ?? "")) {
                recipientShield = { pubkey: BigInt(r.pubkey), encKey: hexToBytes(r.encPubkeyHex!) };
              }
            }
          } catch {
            /* malformed identity → fall back to public withdraw */
          }

          // 2. Fetch the live pool root (the deposit binds to a known root).
          post({ type: "progress", message: "Connecting to the shielded pool…" });
          const rootRes = await postJson("/api/shield/merkle-path", { coinType, dummy: true });
          if (!rootRes.ok) throw new Error("The shielded pool is busy. Try again shortly.");
          const currentRoot = rootRes.body.currentRoot as string | undefined;
          if (!currentRoot) throw new Error("The shielded pool is syncing. Try again shortly.");

          // 2b. SCAN-FIRST: a shielded note IS spendable balance. If an UNSPENT
          // note you already own covers this amount (e.g. a prior send whose
          // withdraw didn't fire — the funds are already in the pool), spend THAT
          // to the recipient and skip the deposit. Completes stranded sends + is
          // faster (no deposit/sign/index round-trip). Best-effort: any failure
          // falls through to the normal deposit flow.
          const relayerRes0 = await fetch("/api/shield/relayer", { credentials: "same-origin" });
          const relayer0 = (await relayerRes0.json().catch(() => ({}))) as { zeroCoinSourceId?: string };
          if (relayer0.zeroCoinSourceId) {
            // PRIVATE TRANSFER (hidden amount) — the real privacy primitive. If
            // the recipient has a published shield identity AND we hold a covering
            // unspent note, send it shielded→shielded: public_amount=0, so NO
            // amount and NO recipient land on-chain (only commitments/nullifiers).
            // Recipient receives a shielded note they later cash out themselves.
            if (recipientShield) {
              post({ type: "progress", message: "Sending privately — amount hidden…" });
              const transferred = await spendOrTransferToShield({
                cfg,
                keypair,
                amount,
                recipientPubkey: recipientShield.pubkey,
                recipientEncKey: recipientShield.encKey,
                zeroCoinSourceId: relayer0.zeroCoinSourceId,
              });
              if (transferred?.digest) {
                post({ type: "result", digest: transferred.digest });
                return;
              }
              // No covering note for a transfer → fall through (deposit then a
              // public withdraw today; deposit→transfer is the fast-follow).
            }
            post({ type: "progress", message: "Checking your shielded balance…" });
            // No blanket catch: spendExistingNote returns null only when there's
            // NO matching note (→ deposit). If it FINDS one but the withdraw
            // fails, it throws → surfaced below, and we do NOT deposit again.
            const reused = await spendExistingNote({
              cfg,
              keypair,
              amount,
              exitAddress: recipient,
              zeroCoinSourceId: relayer0.zeroCoinSourceId,
              root: BigInt(currentRoot),
            });
            if (reused?.digest) {
              post({ type: "result", digest: reused.digest });
              return;
            }
          }

          // 3. PROVE the deposit in-page (Groth16, WASM) — note secrets stay here.
          post({ type: "progress", message: "Sealing your transfer…" });
          const prepared = await proveShieldDeposit({
            cfg,
            keypair,
            amount,
            root: BigInt(currentRoot),
          });

          // 4. Build the sponsor-ready deposit PTB server-side (sources the coin
          //    from the user's balance), then NATIVE zkLogin-signs + submits it.
          const prep = await postJson("/api/shield/deposit/prepare", {
            amountMicros: micros,
            proof: prepared.proof,
            enc0B64: prepared.enc0B64,
            enc1B64: prepared.enc1B64,
          });
          if (prep.status === 503 && prep.body.code === "SHIELD_INAPP_OFF") {
            // Feature flag off — honest, non-lossy status. Funds untouched.
            post({
              type: "error",
              message:
                "Your private key is set up on this device. One-tap private send is finalizing — your funds are untouched.",
            });
            return;
          }
          if (prep.status === 409 && prep.body.code === "ROOT_STALE") {
            throw new Error("The pool just updated — please try again.");
          }
          if (!prep.ok || typeof prep.body.bytes !== "string") {
            throw new Error((prep.body.error as string) || "Couldn’t prepare the private send.");
          }

          post({ type: "progress", message: "Confirm on your device…" });
          const depositDigest = await signDepositNative(prep.body.bytes as string);

          // 5. Wait for the deposit commitment to index (its leaf enters the tree
          //    so the withdraw can authenticate against it). Poll ~3 min.
          post({ type: "progress", message: "Funds shielded — completing your transfer…" });
          const commitment = prepared.outputNote.commitment;
          let leafIndex: number | null = null;
          let postDepositRoot: string | null = null;
          for (let i = 0; i < 90 && leafIndex === null; i++) {
            const p = await postJson("/api/shield/merkle-path", { coinType, commitment });
            if (p.ok && typeof p.body.leafIndex === "number") {
              leafIndex = p.body.leafIndex as number;
              postDepositRoot = (p.body.root as string) ?? null;
            } else {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
          if (leafIndex === null || !postDepositRoot) {
            // Non-lossy: the deposit landed (funds are shielded + the note is
            // recoverable from the seed); the transfer completes once indexed.
            post({
              type: "error",
              message:
                "Your funds are shielded. The private transfer will complete after the next confirmation — your money is safe (deposit " +
                depositDigest.slice(0, 10) +
                "…).",
            });
            return;
          }

          // 6. PROVE + relay the WITHDRAW to the recipient (relayer-signed).
          const relayerRes = await fetch("/api/shield/relayer", { credentials: "same-origin" });
          const relayer = (await relayerRes.json()) as { zeroCoinSourceId?: string };
          if (!relayer.zeroCoinSourceId) {
            post({
              type: "error",
              message:
                "Your funds are shielded. The private transfer is queued and will complete shortly — your money is safe.",
            });
            return;
          }
          const inputNote: FlowInputNote = {
            privateKey: keypair.spendingKey,
            amount,
            blinding: BigInt(prepared.outputNote.blinding),
            leafIndex,
            commitment: BigInt(commitment),
          };
          const { digest: withdrawDigest } = await shieldWithdraw({
            cfg,
            keypair,
            inputNotes: [inputNote],
            amount,
            exitAddress: recipient,
            zeroCoinSourceId: relayer.zeroCoinSourceId,
            root: BigInt(postDepositRoot),
          });

          post({ type: "result", digest: withdrawDigest });
        } catch (e) {
          post({ type: "error", message: (e as Error).message || "Private send failed." });
        }
      })();
    };

    // ── ONE-TAP RECOVERY SWEEP ────────────────────────────────────────────
    // Scan every UNSPENT shielded note the user owns and withdraw each back to
    // their own wallet — reclaims a balance stranded by earlier failed withdraws.
    window.taliseShieldRecover = (seedHex: string, destination: string) => {
      void (async () => {
        try {
          post({ type: "progress", message: "Unlocking your private key…" });
          if (!live || !packageId || !poolObjectId) throw new Error("Private send isn’t switched on yet.");
          if (!/^0x[a-f0-9]{64}$/i.test(destination)) throw new Error("Invalid destination address.");
          if (!/^[0-9a-f]{32,128}$/i.test(seedHex)) throw new Error("Couldn’t unlock your private key on this device.");
          const keypair = await deriveShieldKeypairFromSeed(seedFromHex(seedHex));
          if (keypair.spendingKey <= 0n) throw new Error("Key derivation failed.");

          post({ type: "progress", message: "Finding your shielded balance…" });
          const relRes = await fetch("/api/shield/relayer", { credentials: "same-origin" });
          const rel = (await relRes.json().catch(() => ({}))) as { zeroCoinSourceId?: string };
          if (!rel.zeroCoinSourceId) throw new Error("The shielded pool is busy. Try again shortly.");

          post({ type: "progress", message: "Recovering your funds…" });
          const res = await sweepShieldedBalance({
            cfg,
            keypair,
            destination,
            zeroCoinSourceId: rel.zeroCoinSourceId,
          });

          if (res.swept.length === 0) {
            post({
              type: "error",
              message:
                res.failed > 0
                  ? "Couldn’t recover right now — please try again shortly. Your funds are safe."
                  : "No recoverable shielded balance found.",
            });
            return;
          }
          const dollars = (Number(res.totalMicros) / 1e6).toFixed(2);
          // Resolve the native continuation; the last digest is a concrete proof.
          post({ type: "result", digest: res.swept[res.swept.length - 1].digest });
          post({
            type: "progress",
            message: `Recovered $${dollars} across ${res.swept.length} note(s)${res.failed ? ` (${res.failed} pending)` : ""}.`,
          });
        } catch (e) {
          post({ type: "error", message: (e as Error).message || "Recovery failed." });
        }
      })();
    };

    // ── SHIELDED BALANCE (read-only) ──────────────────────────────────────
    // Sum the user's unspent notes; report micros via { result, digest }.
    window.taliseShieldBalance = (seedHex: string) => {
      void (async () => {
        try {
          if (!live || !packageId || !poolObjectId) {
            post({ type: "result", digest: "0" });
            return;
          }
          if (!/^[0-9a-f]{32,128}$/i.test(seedHex)) throw new Error("Couldn’t read your shielded balance.");
          const keypair = await deriveShieldKeypairFromSeed(seedFromHex(seedHex));
          void ensureIdentityPublished(keypair);
          const micros = await shieldedBalanceMicros({ cfg, keypair });
          post({ type: "result", digest: micros.toString() });
        } catch (e) {
          post({ type: "error", message: (e as Error).message || "Couldn’t read your shielded balance." });
        }
      })();
    };

    return () => {
      delete window.taliseShieldSend;
      delete window.taliseShieldRecover;
      delete window.taliseShieldBalance;
      delete window.__taliseDepositSigned;
    };
  }, [live, packageId, poolObjectId, coinType]);

  // Invisible — the native side mounts this in a 0×0 web view.
  return <div data-shield-prove="ready" style={{ width: 1, height: 1, opacity: 0 }} />;
}
