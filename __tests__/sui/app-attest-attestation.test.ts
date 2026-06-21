/**
 * Tests for the App Attest ATTESTATION path (F4 register).
 *
 * Two layers:
 *  1. Deterministic checks that need no certificate — public-key extraction,
 *     signCount==0, rpIdHash, AAGUID. These lock parseAuthData + the
 *     credential-key SPKI we persist.
 *  2. A synthetic END-TO-END chain (real EC certs minted with openssl): a leaf
 *     whose key IS the credential key, carrying the Apple nonce extension,
 *     signed by a throwaway root that we pin via APPLE_APP_ATTEST_ROOT_CA_PEM.
 *     This proves the x5c chain walk + nonce (over the base64-DECODED challenge)
 *     + key-identity checks accept a well-formed attestation and reject a
 *     tampered one. Skips gracefully if openssl is unavailable.
 */
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encode as cborEncode } from "cbor-x";
import { verifyAttestation, appAttestAppId } from "../../lib/app-attest-verify";

function sha256(...b: Buffer[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const x of b) h.update(x);
  return h.digest();
}

function p256Xy(pub: crypto.KeyObject): { x: Buffer; y: Buffer; rawPoint: Buffer; spki: Buffer } {
  const jwk = pub.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const rawPoint = Buffer.concat([Buffer.from([0x04]), x, y]);
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  return { x, y, rawPoint, spki };
}

function coseKey(x: Buffer, y: Buffer): Buffer {
  // COSE_Key EC2/P-256/ES256: kty(1)=2, alg(3)=-7, crv(-1)=1, x(-2), y(-3).
  return Buffer.from(
    cborEncode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ])
    )
  );
}

function buildAuthData(opts: {
  appId: string;
  signCount: number;
  aaguid: string;
  credId: Buffer;
  x: Buffer;
  y: Buffer;
}): Buffer {
  const rpIdHash = sha256(Buffer.from(opts.appId, "utf8"));
  const flags = Buffer.from([0x40]);
  const sc = Buffer.alloc(4);
  sc.writeUInt32BE(opts.signCount >>> 0);
  const aaguid = Buffer.alloc(16);
  Buffer.from(opts.aaguid, "utf8").copy(aaguid);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(opts.credId.length);
  return Buffer.concat([rpIdHash, flags, sc, aaguid, credLen, opts.credId, coseKey(opts.x, opts.y)]);
}

function buildAttestation(authData: Buffer, x5c?: Buffer[]): string {
  const attStmt: { x5c?: Uint8Array[] } = {};
  if (x5c) attStmt.x5c = x5c.map((c) => new Uint8Array(c));
  return Buffer.from(cborEncode({ fmt: "apple-appattest", attStmt, authData })).toString("base64");
}

describe("verifyAttestation — deterministic checks (no cert)", () => {
  const appId = appAttestAppId();
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x, y, rawPoint, spki } = p256Xy(publicKey);
  const credId = sha256(rawPoint);
  const challenge = crypto.randomBytes(32).toString("base64");

  it("extracts the credential public key + signCount (no x5c → chainVerified false)", () => {
    const authData = buildAuthData({ appId, signCount: 0, aaguid: "appattest", credId, x, y });
    const r = verifyAttestation({ attestationBase64: buildAttestation(authData), challenge });
    expect(r.publicKeyDer.equals(spki)).toBe(true);
    expect(r.signCount).toBe(0);
    expect(r.chainVerified).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/no x5c/);
  });

  it("rejects a non-zero attestation signCount", () => {
    const authData = buildAuthData({ appId, signCount: 5, aaguid: "appattest", credId, x, y });
    expect(() => verifyAttestation({ attestationBase64: buildAttestation(authData), challenge })).toThrow(
      /signCount/
    );
  });

  it("rejects a wrong rpId (app-id mismatch)", () => {
    const authData = buildAuthData({ appId: "WRONG.app.id", signCount: 0, aaguid: "appattest", credId, x, y });
    expect(() => verifyAttestation({ attestationBase64: buildAttestation(authData), challenge })).toThrow(
      /rpIdHash/
    );
  });

  it("rejects an unexpected AAGUID", () => {
    const authData = buildAuthData({ appId, signCount: 0, aaguid: "evilguid", credId, x, y });
    expect(() => verifyAttestation({ attestationBase64: buildAttestation(authData), challenge })).toThrow(
      /AAGUID/
    );
  });
});

// ── Synthetic end-to-end chain (needs openssl) ──────────────────────────────
function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())("verifyAttestation — synthetic x5c chain + nonce + key identity", () => {
  const appId = appAttestAppId();
  let dir: string;
  let credSpki: Buffer;
  let credX: Buffer;
  let credY: Buffer;
  let credId: Buffer;
  let rootPem: string;
  const challenge = crypto.randomBytes(32).toString("base64");
  let authData: Buffer;

  function mintLeaf(nonce: Buffer): Buffer {
    // Apple nonce extension value: SEQUENCE { [1] OCTET STRING(32) }.
    const der = Buffer.concat([
      Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]),
      nonce,
    ]).toString("hex");
    const ext = path.join(dir, "ext.cnf");
    fs.writeFileSync(ext, `[v3]\n1.2.840.113635.100.8.2=DER:${der}\n`);
    execFileSync("openssl", [
      "req", "-new", "-key", path.join(dir, "cred.key"),
      "-subj", "/CN=leaf", "-out", path.join(dir, "leaf.csr"),
    ]);
    execFileSync("openssl", [
      "x509", "-req", "-in", path.join(dir, "leaf.csr"),
      "-CA", path.join(dir, "root.pem"), "-CAkey", path.join(dir, "root.key"),
      "-days", "3650", "-extfile", ext, "-extensions", "v3",
      "-out", path.join(dir, "leaf.pem"),
    ]);
    execFileSync("openssl", [
      "x509", "-in", path.join(dir, "leaf.pem"), "-outform", "DER", "-out", path.join(dir, "leaf.der"),
    ]);
    return fs.readFileSync(path.join(dir, "leaf.der"));
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-"));
    // Credential key (the attested key) — written to disk so openssl mints the
    // leaf with this exact public key.
    const cred = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    fs.writeFileSync(path.join(dir, "cred.key"), cred.privateKey.export({ format: "pem", type: "pkcs8" }) as string);
    const xy = p256Xy(cred.publicKey);
    credSpki = xy.spki; credX = xy.x; credY = xy.y;
    credId = sha256(xy.rawPoint);
    // Throwaway root CA, pinned via env for this suite.
    execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", path.join(dir, "root.key")]);
    execFileSync("openssl", ["req", "-x509", "-new", "-key", path.join(dir, "root.key"), "-days", "3650", "-subj", "/CN=Test App Attest Root", "-out", path.join(dir, "root.pem")]);
    rootPem = fs.readFileSync(path.join(dir, "root.pem"), "utf8");
    process.env.APPLE_APP_ATTEST_ROOT_CA_PEM = rootPem;
    authData = buildAuthData({ appId, signCount: 0, aaguid: "appattest", credId, x: credX, y: credY });
  });

  it("accepts a well-formed attestation (chainVerified=true) + returns the credential key", () => {
    const nonce = sha256(authData, sha256(Buffer.from(challenge, "base64")));
    const leaf = mintLeaf(nonce);
    const r = verifyAttestation({ attestationBase64: buildAttestation(authData, [leaf]), challenge });
    expect(r.chainVerified).toBe(true);
    expect(r.publicKeyDer.equals(credSpki)).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it("does NOT verify when the nonce is wrong (challenge tampered)", () => {
    const wrongNonce = sha256(authData, sha256(Buffer.from("not-the-challenge")));
    const leaf = mintLeaf(wrongNonce);
    const r = verifyAttestation({ attestationBase64: buildAttestation(authData, [leaf]), challenge });
    expect(r.chainVerified).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/nonceOk=false/);
  });

  it("does NOT verify when the leaf is not chained to the pinned root", () => {
    const nonce = sha256(authData, sha256(Buffer.from(challenge, "base64")));
    const leaf = mintLeaf(nonce);
    // Pin a DIFFERENT root → chain walk fails.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "attest-other-"));
    execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", path.join(other, "r.key")]);
    execFileSync("openssl", ["req", "-x509", "-new", "-key", path.join(other, "r.key"), "-days", "3650", "-subj", "/CN=Other Root", "-out", path.join(other, "r.pem")]);
    const saved = process.env.APPLE_APP_ATTEST_ROOT_CA_PEM;
    process.env.APPLE_APP_ATTEST_ROOT_CA_PEM = fs.readFileSync(path.join(other, "r.pem"), "utf8");
    const r = verifyAttestation({ attestationBase64: buildAttestation(authData, [leaf]), challenge });
    process.env.APPLE_APP_ATTEST_ROOT_CA_PEM = saved;
    expect(r.chainVerified).toBe(false);
  });
});
