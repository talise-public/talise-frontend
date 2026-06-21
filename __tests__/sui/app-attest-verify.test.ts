/**
 * Deterministic unit tests for the App Attest ASSERTION verification (F4),
 * using a synthetic P-256 key (no Apple cert needed — the assertion path is
 * what gates every money request). Pins the signature interpretation
 * (ECDSA-SHA256 over authenticatorData ‖ clientDataHash) + counter + rpId.
 * The attestation x5c-chain path needs a real device-captured fixture and is
 * validated separately before enforce-mode.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { encode as cborEncode } from "cbor-x";
import { verifyAssertion, appAttestAppId } from "../../lib/app-attest-verify";

function sha256(...b: Buffer[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const x of b) h.update(x);
  return h.digest();
}

function makeAssertion(opts: {
  priv: crypto.KeyObject;
  appId: string;
  counter: number;
  clientDataHash: Buffer;
}): string {
  const rpIdHash = sha256(Buffer.from(opts.appId, "utf8"));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.counter);
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x00]), counter]);
  const signature = crypto.sign(
    "sha256",
    Buffer.concat([authData, opts.clientDataHash]),
    opts.priv
  );
  return Buffer.from(
    cborEncode({ signature, authenticatorData: authData })
  ).toString("base64");
}

describe("verifyAssertion (App Attest, synthetic key)", () => {
  const appId = appAttestAppId();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const cdh = sha256(Buffer.from(JSON.stringify({ hello: "world" }), "utf8"));

  it("accepts a valid assertion + returns the new counter", () => {
    const a = makeAssertion({ priv: privateKey, appId, counter: 7, clientDataHash: cdh });
    expect(
      verifyAssertion({ assertionBase64: a, clientDataHash: cdh, publicKeyDer: pubDer, storedCounter: 0, appId }).newCounter
    ).toBe(7);
  });

  it("rejects a replayed/stale counter (<= stored)", () => {
    const a = makeAssertion({ priv: privateKey, appId, counter: 3, clientDataHash: cdh });
    expect(() =>
      verifyAssertion({ assertionBase64: a, clientDataHash: cdh, publicKeyDer: pubDer, storedCounter: 3, appId })
    ).toThrow(/counter/);
  });

  it("rejects a tampered request body (clientDataHash mismatch)", () => {
    const a = makeAssertion({ priv: privateKey, appId, counter: 9, clientDataHash: cdh });
    const otherCdh = sha256(Buffer.from("different body"));
    expect(() =>
      verifyAssertion({ assertionBase64: a, clientDataHash: otherCdh, publicKeyDer: pubDer, storedCounter: 0, appId })
    ).toThrow(/signature/);
  });

  it("rejects a wrong-key signature", () => {
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const a = makeAssertion({ priv: other.privateKey, appId, counter: 5, clientDataHash: cdh });
    expect(() =>
      verifyAssertion({ assertionBase64: a, clientDataHash: cdh, publicKeyDer: pubDer, storedCounter: 0, appId })
    ).toThrow(/signature/);
  });

  it("rejects a wrong rpId (app-id mismatch)", () => {
    const a = makeAssertion({ priv: privateKey, appId: "WRONG.app.id", counter: 4, clientDataHash: cdh });
    expect(() =>
      verifyAssertion({ assertionBase64: a, clientDataHash: cdh, publicKeyDer: pubDer, storedCounter: 0, appId })
    ).toThrow(/rpIdHash/);
  });
});
