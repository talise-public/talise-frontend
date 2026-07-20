# App Attest: remaining work

This file enumerates the work that was deliberately deferred from the
P1-5 fix shipped in the same commit. The current state gives us:

- one-time, server-persisted challenges (5-minute TTL) issued by
  `/api/auth/attest/challenge` and consumed atomically by
  `/api/auth/attest/register`,
- an enforcement skeleton (`requireAppAttestStructural`) wired into
  the three sensitive routes called out by the audit
  (`/api/zk/sponsor-execute`, `/api/onramp/*`, `/api/tx/record`),
- an iOS-side `AppAttestService.bootstrap` call sites that fires
  immediately after bearer issuance.

What is NOT done yet:

## 1. Apple attestation chain verification

`/api/auth/attest/register` accepts the attestation blob and stores
it, but does not yet:

- decode the CBOR-encoded attestation object,
- walk `attestationObject -> fmt = "apple-appattest"` and the
  enclosed cert chain,
- verify the chain against Apple's `AppleAppAttestRoot` CA,
- check that the leaf cert's `1.2.840.113635.100.8.2` extension
  embeds `SHA256(authenticatorData || clientDataHash)` where
  `clientDataHash = SHA256(challenge)`,
- check `authenticatorData.rpIdHash == SHA256(teamID || "." || bundleID)`,
- assert `counter == 0`,
- extract and persist the `credentialPublicKey` (and `AAGUID`) so
  future assertions can be verified by signature + counter
  monotonicity.

There is no maintained pure-TS Apple App Attest library on npm at the
time of writing. Options:

- Hand-roll using `cbor-x` + `node:crypto` (X.509 chain validation
  is the largest piece; `node:crypto.X509Certificate` plus an
  embedded copy of the Apple root cert is enough).
- Port from one of the open-source server implementations in Go
  (`takimoto/appattest`) or Python (`pyappattest`).

Either path is one focused PR's worth of work. Until it lands,
attestation registration is best treated as advisory: the challenge
half is real, the verification half is not.

## 2. Per-request assertion verification

`requireAppAttestStructural` checks only that `X-App-Attest` and
`X-App-Attest-KeyId` are present on mobile money-moving routes. It
does NOT verify:

- the assertion bytes against the stored attestation,
- the counter is strictly increasing per `key_id`,
- the `clientDataHash` matches `SHA256(requestBody)` (which iOS
  already computes in `APIClient.swift`).

Until phase 2 ships, a stolen bearer can fabricate the two headers
with arbitrary values and our routes will let the request through.
This is still a strict improvement over the prior state (zero
enforcement) and lets us deploy the iOS bootstrap call site without
hard-failing existing sessions.

## 3. Dev / simulator bypass

`AppAttestService.bootstrap` already short-circuits when
`DCAppAttestService.isSupported == false` (sim, Mac Catalyst). The
server side currently treats a missing header on a mobile request
as a 401. We need either:

- a server env flag (`TALISE_APP_ATTEST_REQUIRED=0`) for staging /
  TestFlight builds that hit the production API from a sim, OR
- bind enforcement to a per-environment policy that mirrors how iOS
  builds report their build configuration.

## Verification once phase 2 ships

- replay an old attestation: register endpoint returns 400
  (already enforced by the challenge layer).
- forge an attestation from another team's bundle id: register
  returns 400 (RPID hash mismatch).
- send a forged assertion to `/api/zk/sponsor-execute`: 401 with a
  body indicating signature / counter failure.
- counter regression: re-use a stale assertion: 401.

The corresponding negative tests should live under
`web/__tests__/app-attest.spec.ts` and run against the real
verification helpers, not stubs.
