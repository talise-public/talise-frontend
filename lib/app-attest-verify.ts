import "server-only";

import crypto from "node:crypto";
import { decode as cborDecode } from "cbor-x";

/**
 * Apple App Attest verification (F4). Implements the two verifications from
 * Apple's spec ("Validating Apps That Connect to Your Server"):
 *   - verifyAttestation: on register — decode the CBOR attestation, extract +
 *     return the credential P-256 public key, run the deterministic checks
 *     (rpIdHash, AAGUID, signCount==0), AND verify the full x5c chain → the
 *     pinned Apple App Attestation Root CA, the nonce (SHA256(authData ‖
 *     SHA256(challenge-bytes)) == the cert's 1.2.840.113635.100.8.2 extension),
 *     and key identity (credential key == leaf cert key, credentialId ==
 *     SHA256(key)). Returns `chainVerified`; register requires it in enforce
 *     mode (see lib/app-attest.ts appAttestMode()).
 *   - verifyAssertion: per money request — verify the ECDSA-P256 signature over
 *     SHA256(authenticatorData ‖ clientDataHash) against the stored key, the
 *     rpIdHash, and strict counter monotonicity (clone/replay defense). FULLY
 *     unit-tested against a synthetic key (see __tests__).
 *
 * Refs: developer.apple.com/documentation/devicecheck/
 *   establishing-your-app-s-integrity + validating-apps-that-connect-to-your-server
 */

// app id = "<TeamID>.<BundleID>" (Team 5N8DU2A9WH, bundle io.talise.app).
// Env-overridable so a re-provision doesn't need a deploy.
export function appAttestAppId(): string {
  return process.env.APP_ATTEST_APP_ID ?? "5N8DU2A9WH.io.talise.app";
}

// Pinned "Apple App Attestation Root CA" (apple.com/certificateauthority/
// Apple_App_Attestation_Root_CA.pem). Self-signed, valid 2020-03-18..2045-03-15,
// SHA256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:
// F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32. The x5c chain is now verified against
// this by default; the env var overrides it so a future Apple rotation needs no
// code deploy.
const PINNED_APPLE_APP_ATTEST_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;
function rootCaPem(): string {
  return process.env.APPLE_APP_ATTEST_ROOT_CA_PEM || PINNED_APPLE_APP_ATTEST_ROOT_CA;
}

const NONCE_OID = "1.2.840.113635.100.8.2";

type AuthData = {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  aaguid: Buffer; // 16 bytes (present only in attestation authData)
  credentialId: Buffer | null; // = Apple keyId = SHA256(credential public key)
  credentialPublicKeyDer: Buffer | null;
};

/**
 * Parse the WebAuthn-style authenticator data. Layout:
 *   rpIdHash[32] ‖ flags[1] ‖ signCount[4]  (assertion stops here)
 *   ‖ aaguid[16] ‖ credIdLen[2] ‖ credId[credIdLen] ‖ COSE_pubkey (attestation)
 */
function parseAuthData(authData: Buffer, withCredential: boolean): AuthData {
  if (authData.length < 37) throw new Error("authData too short");
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  if (!withCredential) {
    return {
      rpIdHash,
      flags,
      signCount,
      aaguid: Buffer.alloc(0),
      credentialId: null,
      credentialPublicKeyDer: null,
    };
  }
  const aaguid = authData.subarray(37, 53);
  const credIdLen = authData.readUInt16BE(53);
  const credIdEnd = 55 + credIdLen;
  const credentialId = authData.subarray(55, credIdEnd);
  const coseRaw = authData.subarray(credIdEnd);
  const cose = cborDecode(coseRaw) as Map<number, unknown> | Record<number, unknown>;
  const get = (k: number): unknown =>
    cose instanceof Map ? cose.get(k) : (cose as Record<number, unknown>)[k];
  // COSE EC2 / P-256: kty(1)=2, crv(-1)=1, x(-2)=32B, y(-3)=32B.
  if (Number(get(1)) !== 2 || Number(get(-1)) !== 1) {
    throw new Error("credential key is not COSE EC2 P-256");
  }
  const x = Buffer.from(get(-2) as Uint8Array);
  const y = Buffer.from(get(-3) as Uint8Array);
  if (x.length !== 32 || y.length !== 32) throw new Error("bad EC point length");
  return {
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credentialId,
    credentialPublicKeyDer: p256RawToDerSpki(x, y),
  };
}

/** Wrap an uncompressed P-256 point (x,y) in the fixed SPKI ASN.1 header → DER. */
function p256RawToDerSpki(x: Buffer, y: Buffer): Buffer {
  const SPKI_P256_PREFIX = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex"
  );
  return Buffer.concat([SPKI_P256_PREFIX, Buffer.from([0x04]), x, y]);
}

function sha256(...parts: Buffer[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export type AttestationResult = {
  publicKeyDer: Buffer;
  signCount: number;
  /** Whether the full x5c→Apple-root chain + nonce verified (vs deterministic-only). */
  chainVerified: boolean;
  warnings: string[];
};

/**
 * Verify a registration attestation and return the credential public key to
 * store. Throws on a deterministic failure (bad rpIdHash / AAGUID / signCount /
 * malformed). The x5c chain + nonce are verified only when the Apple root CA is
 * pinned; otherwise `chainVerified=false` + a warning (caller decides per mode).
 */
export function verifyAttestation(input: {
  attestationBase64: string;
  challenge: string; // the base64 challenge string the client attested over
  appId?: string;
}): AttestationResult {
  const appId = input.appId ?? appAttestAppId();
  const obj = cborDecode(Buffer.from(input.attestationBase64, "base64")) as {
    fmt?: string;
    attStmt?: { x5c?: Uint8Array[]; receipt?: Uint8Array };
    authData?: Uint8Array;
  };
  if (obj.fmt !== "apple-appattest") throw new Error(`bad fmt ${obj.fmt}`);
  if (!obj.authData) throw new Error("missing authData");
  const authData = Buffer.from(obj.authData);
  const ad = parseAuthData(authData, true);

  // Deterministic checks (no Apple cert needed).
  if (!ad.rpIdHash.equals(sha256(Buffer.from(appId, "utf8")))) {
    throw new Error("rpIdHash mismatch");
  }
  if (ad.signCount !== 0) throw new Error(`attestation signCount ${ad.signCount} != 0`);
  const aaguidStr = ad.aaguid.toString("utf8").replace(/\0+$/, "");
  if (aaguidStr !== "appattest" && aaguidStr !== "appattestdevelop") {
    throw new Error(`unexpected AAGUID "${aaguidStr}"`);
  }
  if (!ad.credentialPublicKeyDer) throw new Error("no credential public key");

  const warnings: string[] = [];
  let chainVerified = false;
  const x5c = obj.attStmt?.x5c;
  if (!x5c || x5c.length === 0) {
    warnings.push("no x5c in attestation");
  } else {
    // Full chain + nonce + key-identity verification against the pinned root.
    try {
      const credCert = new crypto.X509Certificate(Buffer.from(x5c[0]));
      const root = new crypto.X509Certificate(rootCaPem());
      // Walk x5c → root: each cert issued by the next, last issued by root.
      let ok = true;
      for (let i = 0; i < x5c.length; i++) {
        const cur = new crypto.X509Certificate(Buffer.from(x5c[i]));
        const issuer =
          i + 1 < x5c.length
            ? new crypto.X509Certificate(Buffer.from(x5c[i + 1]))
            : root;
        if (!cur.checkIssued(issuer) || !cur.verify(issuer.publicKey)) {
          ok = false;
          break;
        }
      }
      // nonce = SHA256(authData ‖ clientDataHash). The client hashes the RAW
      // challenge bytes — iOS does SHA256(Data(base64Encoded: challenge)) — so
      // decode the base64 challenge STRING here, not its utf8 bytes.
      const clientDataHash = sha256(Buffer.from(input.challenge, "base64"));
      const expectedNonce = sha256(authData, clientDataHash);
      const certNonce = readNonceExtension(Buffer.from(credCert.raw));
      const nonceOk = certNonce != null && certNonce.equals(expectedNonce);
      // Key identity (Apple step 6): the credential key in authData MUST be the
      // leaf cert's public key, and the credentialId MUST equal SHA256(that key)
      // — i.e. Apple's keyId. Binds the attested key to the attestation cert.
      const leafSpki = credCert.publicKey.export({ format: "der", type: "spki" }) as Buffer;
      const keyMatches =
        ad.credentialPublicKeyDer != null && leafSpki.equals(ad.credentialPublicKeyDer);
      const rawPoint = leafSpki.subarray(leafSpki.length - 65); // 0x04 ‖ x ‖ y
      const keyIdOk = ad.credentialId != null && sha256(rawPoint).equals(ad.credentialId);
      chainVerified = ok && nonceOk && keyMatches && keyIdOk;
      if (!chainVerified) {
        warnings.push(
          `chain ok=${ok} nonceOk=${nonceOk} keyMatch=${keyMatches} keyId=${keyIdOk} (OID ${NONCE_OID})`
        );
      }
    } catch (e) {
      warnings.push(`chain verify error: ${(e as Error).message}`);
    }
  }

  return { publicKeyDer: ad.credentialPublicKeyDer, signCount: ad.signCount, chainVerified, warnings };
}

/**
 * Minimal ASN.1 walk to pull the 32-byte nonce out of the credCert's
 * 1.2.840.113635.100.8.2 extension (OCTET STRING → SEQUENCE → [1] → OCTET
 * STRING(32)). Returns null if not found. Best-effort; only used when the
 * root CA is pinned, and gated behind device-fixture validation.
 */
function readNonceExtension(certDer: Buffer): Buffer | null {
  // Apple's nonce extension wraps a 32-byte octet string; rather than a full
  // DER parser, locate the OID bytes then the trailing 32-byte octet string.
  const oidBytes = Buffer.from("2a864886f763640802", "hex"); // 1.2.840.113635.100.8.2
  const idx = certDer.indexOf(oidBytes);
  if (idx < 0) return null;
  // Scan forward for an OCTET STRING (0x04) of length 0x20 (32).
  for (let i = idx; i < certDer.length - 34; i++) {
    if (certDer[i] === 0x04 && certDer[i + 1] === 0x20) {
      return certDer.subarray(i + 2, i + 34);
    }
  }
  return null;
}

export type AssertionResult = { newCounter: number };

/**
 * Verify a per-request assertion. Throws on failure. FULLY testable with a
 * synthetic P-256 key (no Apple cert involved — the attested key was captured
 * at register time).
 */
export function verifyAssertion(input: {
  assertionBase64: string;
  clientDataHash: Buffer; // SHA256(rawRequestBody)
  publicKeyDer: Buffer; // the stored P-256 SPKI DER from verifyAttestation
  storedCounter: number;
  appId?: string;
}): AssertionResult {
  const appId = input.appId ?? appAttestAppId();
  const obj = cborDecode(Buffer.from(input.assertionBase64, "base64")) as {
    signature?: Uint8Array;
    authenticatorData?: Uint8Array;
  };
  if (!obj.signature || !obj.authenticatorData) throw new Error("malformed assertion");
  const authData = Buffer.from(obj.authenticatorData);
  const ad = parseAuthData(authData, false);

  if (!ad.rpIdHash.equals(sha256(Buffer.from(appId, "utf8")))) {
    throw new Error("assertion rpIdHash mismatch");
  }

  // Signature is ECDSA-P256 over SHA256(authenticatorData ‖ clientDataHash).
  // crypto.verify("sha256", data, key, sig) hashes `data` then ECDSA-verifies;
  // the Apple signature is DER-encoded (dsaEncoding default "der").
  const key = crypto.createPublicKey({ key: input.publicKeyDer, format: "der", type: "spki" });
  const data = Buffer.concat([authData, input.clientDataHash]);
  const sigOk = crypto.verify("sha256", data, key, Buffer.from(obj.signature));
  if (!sigOk) throw new Error("assertion signature invalid");

  // Strict counter monotonicity — defeats replay + cloned-key reuse.
  if (ad.signCount <= input.storedCounter) {
    throw new Error(`assertion counter ${ad.signCount} <= stored ${input.storedCounter}`);
  }

  return { newCounter: ad.signCount };
}
