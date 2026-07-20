import { NextResponse } from "next/server";
import {
  verifyGoogleIdToken,
  verifyAppleIdToken,
  deriveSuiAddress,
  generateSalt,
} from "@/lib/zklogin";
import {
  upsertUser,
  userByGoogleSub,
  realignAddress,
  localAppleSalt,
  getOrCreateLocalAppleSalt,
} from "@/lib/db";
import { shinamiEnabled, shinamiGetWallet } from "@/lib/shinami";
import { mintZkProof } from "@/lib/zksigner";
import { issueMobileBearer, revokeAllMobileSessions } from "@/lib/mobile-sessions";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { generateNonce } from "@mysten/sui/zklogin";

export const runtime = "nodejs";

/**
 * Mobile sign-in handshake. iOS obtains an OpenID id_token (Google via its
 * own PKCE web flow; Apple via the NATIVE Sign in with Apple sheet) and
 * posts it here along with the ephemeral key material. We:
 *   1. Verify the JWT's SIGNATURE + iss/aud/exp against the provider's JWKS.
 *   2. (Apple) Verify the JWT's `nonce` is the zkLogin Poseidon nonce derived
 *      from (ephemeralPubKey, maxEpoch, randomness), binds token → session.
 *   3. Resolve the zkLogin salt (Shinami-managed; local fallback for Apple)
 *      to derive the deterministic Sui address.
 *   4. Upsert the user row exactly the way /auth/callback does on web.
 *   5. Pre-mint a zkLogin proof so the first /api/zk/sponsor-execute call
 *      doesn't pay the 2-4s Shinami latency.
 *   6. Issue a mobile bearer token bound to this user id.
 *
 * Body (Google, DEFAULT, unchanged legacy shape):
 *   { idToken, ephemeralPubKeyB64, jwtRandomness, maxEpoch }
 * Body (Apple):
 *   { provider: "apple", idToken, ephemeralPubKeyB64, maxEpoch, randomness }
 *
 * Response shape is IDENTICAL for both providers.
 *
 * Notes:
 *  - No state cookie / no redirect URI dance, that's all client-side.
 *  - We do NOT set the web session cookie. Mobile is bearer-only.
 *  - Apple identity tokens expire ~10 min after issuance; we verify + mint
 *    the proof immediately, and the proof stays valid until maxEpoch. Later
 *    re-mint failures surface as session_rebind_required, which iOS already
 *    handles (same recovery path as a stale Google JWT).
 */

/** Subjects from Sign in with Apple live in the (legacy-named) google_sub
 *  column with this prefix, it's a plain UNIQUE TEXT lookup key. */
const APPLE_SUB_PREFIX = "apple:";

function appleBundleId(): string {
  return process.env.APPLE_BUNDLE_ID?.trim() || "io.talise.app";
}

/** Normalize base64url → standard base64 with padding (same logic as
 *  /api/auth/mobile/start) so iOS can send either form. */
function normalizeB64(raw: string): string {
  const std = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "+");
  return std + "=".repeat((4 - (std.length % 4)) % 4);
}

/**
 * True when a Shinami error means "Shinami processed the request and REJECTED
 * this JWT" (unknown issuer/audience → HTTP 4xx or a JSON-RPC application
 * error like -32602 Invalid params). False for 5xx / timeouts / network
 * flakes, those must NOT trigger the local-salt fallback, because minting a
 * local salt during a transient outage would pin the subject to a different
 * wallet address than Shinami would later serve.
 *
 * Error shapes come from lib/shinami.ts rpc():
 *   HTTP:     "shinami <method> <status>: <body>"
 *   JSON-RPC: "shinami <method>: <message> (<code>)"
 */
function isShinamiJwtRejection(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "");
  if (/^shinami \S+ 4\d\d:/.test(msg)) return true; // HTTP 4xx
  if (/^shinami \S+: .*\(-?\d+\)$/.test(msg)) return true; // JSON-RPC error
  return false;
}

export async function POST(req: Request) {
  // Rate-limit: 5 exchanges per 60s per IP. Tight bound, each exchange
  // mints a zkLogin proof and burns Shinami quota.
  const rl = rateLimit({
    key: `mobile-exchange:${getClientIp(req)}`,
    limit: 5,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  let body: {
    provider?: "google" | "apple";
    idToken?: string;
    ephemeralPubKeyB64?: string;
    jwtRandomness?: string;
    randomness?: string;
    maxEpoch?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Default "google" keeps the legacy body shape working untouched.
  const provider: "google" | "apple" =
    body.provider === "apple" ? "apple" : "google";

  // Per-provider verification + salt/address resolution. Both branches
  // produce the same resolved shape, then converge on the shared
  // upsert → proof pre-mint → bearer → response tail below.
  let subjectKey: string; // value stored in users.google_sub
  let email: string;
  let name: string | null;
  let picture: string | null;
  let salt: string;
  let suiAddress: string;
  let jwtForSession: string;
  let randomness: string; // decimal string used for proof minting
  // Apple-only: persist the nonce-binding triple on the bearer so
  // sponsor-execute re-mints proofs with the EXACT values baked into
  // jwt.nonce (mismatch → -32602 Invalid params at the prover).
  let bearerBinding:
    | { ephemeralPubKeyB64: string; maxEpoch: number; randomness: string }
    | undefined;

  if (provider === "apple") {
    // ── APPLE: native Sign in with Apple identity token ─────────────────
    if (
      !body.idToken ||
      !body.ephemeralPubKeyB64 ||
      !body.randomness ||
      typeof body.maxEpoch !== "number"
    ) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }

    // Signature + iss ("https://appleid.apple.com") + aud (bundle id) + exp.
    // Same takeover rationale as the Google branch, the token is
    // CLIENT-SUBMITTED, so JWKS signature verification is non-negotiable.
    let claims: Awaited<ReturnType<typeof verifyAppleIdToken>>;
    try {
      claims = await verifyAppleIdToken(body.idToken, [appleBundleId()]);
    } catch (err) {
      console.warn(
        `[mobile/exchange] apple id_token verification failed: ${(err as Error).message}`
      );
      return NextResponse.json({ error: "invalid id_token" }, { status: 401 });
    }
    // Apple sends email_verified as boolean OR string.
    if (claims.email_verified === false || claims.email_verified === "false") {
      return NextResponse.json({ error: "email not verified" }, { status: 401 });
    }

    // ── Nonce binding: jwt.nonce MUST equal the zkLogin Poseidon nonce
    // computed from (ephemeralPubKey, maxEpoch, randomness), the same
    // generateNonce the Google web flow uses in /api/auth/mobile/start.
    // Without this check a stolen Apple token could be bound to an
    // attacker-controlled ephemeral key.
    const ephB64 = normalizeB64(body.ephemeralPubKeyB64);
    let ephPubKey: Ed25519PublicKey;
    try {
      ephPubKey = new Ed25519PublicKey(fromBase64(ephB64));
    } catch {
      return NextResponse.json(
        { error: "ephemeralPubKeyB64 is not a valid Ed25519 public key" },
        { status: 400 }
      );
    }
    let expectedNonce: string;
    try {
      expectedNonce = generateNonce(ephPubKey, body.maxEpoch, body.randomness);
    } catch {
      return NextResponse.json(
        { error: "bad nonce inputs (maxEpoch/randomness)" },
        { status: 400 }
      );
    }
    if (!claims.nonce || claims.nonce !== expectedNonce) {
      console.warn(
        `[mobile/exchange] apple nonce mismatch for sub=${claims.sub} (jwt.nonce=${String(
          claims.nonce
        ).slice(0, 16)}…, expected=${expectedNonce.slice(0, 16)}…)`
      );
      return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
    }

    subjectKey = `${APPLE_SUB_PREFIX}${claims.sub}`;
    const existing = await userByGoogleSub(subjectKey);

    // users.email is NOT NULL. Apple includes `email` on every identity
    // token when the user granted the scope (relay addresses included) -
    // but belt-and-suspenders fall back to the stored row for returning
    // users before rejecting.
    const resolvedEmail = claims.email ?? existing?.email;
    if (!resolvedEmail) {
      return NextResponse.json({ error: "missing email" }, { status: 400 });
    }
    email = resolvedEmail;
    // Apple JWTs usually omit name; never clobber a stored one. New users
    // get "" and set a handle later.
    name = claims.name ?? existing?.name ?? "";
    picture = existing?.picture ?? null; // Apple has no picture claim

    // ── Salt resolution. Stability is the only thing that matters here -
    // the salt determines the wallet address and must NEVER change for a
    // subject. Order:
    //   1. Local apple_salts row (subject already pinned to local path).
    //   2. Shinami getOrCreateZkLoginWallet (deterministic per iss+sub on
    //      Shinami's side), the preferred path, same as Google.
    //   3. Shinami REJECTED the apple JWT (unknown aud/iss) → mint a local
    //      salt once (INSERT ON CONFLICT DO NOTHING, read back canonical).
    // Transient Shinami failures (5xx/timeout) abort the sign-in instead of
    // falling back, see isShinamiJwtRejection.
    try {
      const local = await localAppleSalt(`${claims.iss}|${claims.sub}`);
      if (local) {
        salt = local;
        suiAddress = existing?.sui_address ?? deriveSuiAddress(body.idToken, salt);
        console.log(
          `[mobile/exchange] APPLE SALT PATH=local-existing sub=${claims.sub}`
        );
      } else if (shinamiEnabled()) {
        try {
          const wallet = await shinamiGetWallet(body.idToken);
          salt = wallet.salt;
          suiAddress = wallet.address;
          console.log(
            `[mobile/exchange] APPLE SALT PATH=shinami sub=${claims.sub}`
          );
        } catch (err) {
          if (!isShinamiJwtRejection(err)) throw err;
          console.warn(
            `[mobile/exchange] Shinami rejected apple JWT (falling back to local salt): ${
              (err as Error).message
            }`
          );
          salt = await getOrCreateLocalAppleSalt(
            `${claims.iss}|${claims.sub}`,
            generateSalt()
          );
          suiAddress = deriveSuiAddress(body.idToken, salt);
          console.log(
            `[mobile/exchange] APPLE SALT PATH=local-created sub=${claims.sub}`
          );
        }
      } else {
        // No Shinami configured (testnet/dev), local table directly.
        salt = await getOrCreateLocalAppleSalt(
          `${claims.iss}|${claims.sub}`,
          generateSalt()
        );
        suiAddress = deriveSuiAddress(body.idToken, salt);
        console.log(
          `[mobile/exchange] APPLE SALT PATH=local-no-shinami sub=${claims.sub}`
        );
      }
    } catch (err) {
      console.error(
        `[mobile/exchange] apple wallet setup failed for sub=${claims.sub}: ${
          (err as Error).message
        }`
      );
      return NextResponse.json({ error: "wallet setup failed" }, { status: 500 });
    }

    jwtForSession = body.idToken;
    randomness = body.randomness;
    bearerBinding = {
      ephemeralPubKeyB64: ephB64,
      maxEpoch: body.maxEpoch,
      randomness: body.randomness,
    };
  } else {
    // ── GOOGLE: legacy direct-idToken exchange, behavior unchanged ─────
    if (
      !body.idToken ||
      !body.ephemeralPubKeyB64 ||
      !body.jwtRandomness ||
      typeof body.maxEpoch !== "number"
    ) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }

    // Audience must match our iOS OAuth client (allow optional web fallback
    // for dev). Configure via env so we don't ship hard-coded client ids.
    const allowedAudiences = [
      process.env.GOOGLE_CLIENT_ID_IOS,
      process.env.GOOGLE_CLIENT_ID,
    ].filter(Boolean) as string[];
    if (allowedAudiences.length === 0) {
      console.error(
        "[mobile/exchange] no Google client id configured (GOOGLE_CLIENT_ID_IOS/GOOGLE_CLIENT_ID)"
      );
      return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
    }

    // CRITICAL: the id_token is CLIENT-SUBMITTED (iOS runs its own OAuth), so we
    // must verify its SIGNATURE against Google's JWKS before trusting any claim.
    // `verifyGoogleIdToken` enforces signature + iss + aud + exp; without it a
    // forged token carrying a victim's `sub` would mint that victim's bearer
    // (account + wallet takeover). See docs/security/backend-audit-2026-06-01 (F1).
    let claims: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
    try {
      claims = await verifyGoogleIdToken(body.idToken, allowedAudiences);
    } catch (err) {
      console.warn(
        `[mobile/exchange] id_token verification failed: ${(err as Error).message}`
      );
      return NextResponse.json({ error: "invalid id_token" }, { status: 401 });
    }
    if (claims.email_verified === false) {
      return NextResponse.json({ error: "email not verified" }, { status: 401 });
    }

    // Salt + address (Shinami on mainnet, local otherwise).
    try {
      if (shinamiEnabled()) {
        const wallet = await shinamiGetWallet(body.idToken);
        salt = wallet.salt;
        suiAddress = wallet.address;
      } else {
        const existing = await userByGoogleSub(claims.sub);
        salt = existing?.salt ?? generateSalt();
        suiAddress = existing?.sui_address ?? deriveSuiAddress(body.idToken, salt);
      }
    } catch (err) {
      // Don't surface raw Shinami / SDK error strings, they sometimes
      // include the API key prefix or internal endpoint URLs. Log the
      // full message server-side and return a generic 500 to the caller.
      console.error(
        `[mobile/exchange] wallet setup failed for sub=${claims.sub}: ${
          (err as Error).message
        }`
      );
      return NextResponse.json(
        { error: "wallet setup failed" },
        { status: 500 }
      );
    }

    subjectKey = claims.sub;
    email = claims.email;
    name = claims.name ?? null;
    picture = claims.picture ?? null;
    jwtForSession = body.idToken;
    randomness = body.jwtRandomness;
  }

  // ── Shared tail: upsert → realign → proof pre-mint → bearer → response ──

  const country = req.headers.get("x-vercel-ip-country");
  const { user, isNew } = await upsertUser({
    googleSub: subjectKey,
    email,
    name,
    picture,
    suiAddress,
    salt,
    country,
  });

  // Migrate prior rows that drifted from Shinami's current salt/address pair.
  if (user.sui_address !== suiAddress || user.salt !== salt) {
    await realignAddress(user.id, suiAddress, salt);
    user.sui_address = suiAddress;
    user.salt = salt;
  }

  // Pre-mint the proof. If the prover chokes we still return success, the
  // client will retry on first send and pay the cold-start latency then.
  let proof: unknown = null;
  try {
    const minted = await mintZkProof({
      ephemeralPubKeyB64:
        bearerBinding?.ephemeralPubKeyB64 ?? body.ephemeralPubKeyB64!,
      maxEpoch: body.maxEpoch!,
      randomness,
      jwt: jwtForSession,
      salt,
    });
    proof = minted.proof;
  } catch (err) {
    console.warn(
      `[mobile/exchange] proof pre-mint skipped: ${(err as Error).message}`
    );
  }

  // Fresh app sign-in (Apple / native Google): revoke prior mobile_sessions
  // rows BEFORE minting the new bearer so only the current binding remains
  // selectable by the signer. Stops stale rows (old ephemeral key / expired
  // max_epoch) from shadowing the fresh binding on the next deposit.
  await revokeAllMobileSessions(user.id);

  const bearer = await issueMobileBearer(user.id, {
    jwt: jwtForSession,
    salt,
    // Apple: persist the verified nonce-binding triple so sponsor-execute
    // re-mints with the exact values inside jwt.nonce. (Google's direct
    // exchange keeps its legacy behavior, binding is supplied per-send.)
    ephemeralPubKeyB64: bearerBinding?.ephemeralPubKeyB64,
    maxEpoch: bearerBinding?.maxEpoch,
    randomness: bearerBinding?.randomness,
  });

  // Waitlist-handle bind hook. Hooked HERE, right after `upsertUser`
  // has returned a row with a real `sui_address`, and BEFORE we look
  // up the user's owned subnames, so that the subsequent
  // `findTaliseSubnameForOwner` call below picks up the freshly-minted
  // handle on the same response. Fire-and-forget semantics live
  // inside `bindWaitlistHandleIfAny`: it swallows all errors and
  // never throws, so sign-in cannot wedge on it. We `await` only so
  // the resolver in the next block can see the new NFT, the bind
  // call itself returns within one PTB round-trip.
  try {
    const { bindWaitlistHandleIfAny } = await import("@/lib/handle-claim");
    await bindWaitlistHandleIfAny({
      userId: user.id,
      userEmail: user.email,
      suiAddress: user.sui_address,
    });
  } catch (e) {
    // bindWaitlistHandleIfAny already catches internally; this is a
    // belt-and-suspenders guard against the dynamic import failing.
    console.warn(
      `[mobile/exchange] handle bind skipped: ${(e as Error).message}`
    );
  }

  // Returning users may already own a *.talise.sui subname, surface it
  // immediately so HomeView shows the canonical handle without an extra
  // round trip. First-time signers will get `null` here UNLESS the
  // waitlist-handle bind above just minted one; in that case the
  // resolver sees the new NFT on the same response.
  const { findTaliseSubnameForOwner } = await import("@/lib/suins-lookup");
  const subname = await findTaliseSubnameForOwner(user.sui_address)
    .catch(() => null);

  return NextResponse.json({
    user: {
      id: String(user.id),
      email: user.email,
      name: user.name,
      picture: user.picture,
      country: user.country,
      suiAddress: user.sui_address,
      accountType: user.account_type,
      businessName: user.business_name,
      businessHandle: user.business_handle,
      taliseHandle: subname?.username ?? null,
      taliseSubname: subname?.fullName ?? null,
    },
    bearer,
    proof,
    maxEpoch: body.maxEpoch,
    // Additive: true when this provider account already had a Talise user
    // row before this exchange (returning sign-in). Old clients that
    // don't know the field simply ignore it.
    existing: !isNew,
  });
}
