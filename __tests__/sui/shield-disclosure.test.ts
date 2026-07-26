import { describe, expect, it } from "vitest";

/**
 * Selective disclosure for the shielded pool: opening proofs, receipts, and
 * viewing grants.
 *
 * These tests are PURE — no network, no database, no Sui RPC. The chain half of
 * the verifier is exercised through the injectable `chainLookup` seam with
 * fixtures shaped exactly like a fullnode's `sui_getEvents` response, so the
 * anchor logic (found / not-found / mismatch / wrong-package) is covered without
 * depending on mainnet.
 *
 * The two tests that matter most for shipping:
 *   • "rejects a forged disclosure"  — an altered amount must not verify.
 *   • "a viewing key cannot spend"   — a granted key must not yield a nullifier.
 */

import {
  BN254_SCALAR_FIELD,
  deriveShieldEncScalar,
  deriveShieldKeypairFromSeed,
  poseidonStub,
} from "@/lib/shield/sdk/keys";
import { encryptNote } from "@/lib/shield/sdk/encrypt";
import { makeNote, noteCommitment, type Note } from "@/lib/shield/sdk/note";
import {
  buildDisclosureReceipt,
  buildNoteOpening,
  buildSealedViewingGrant,
  buildDelegatedKeyViewingGrant,
  canonicalJson,
  deriveViewingKey,
  documentDigest,
  grantConfersSpendAuthority,
  openGrant,
  poolFieldFromAddress,
  receiptDigest,
  scopeIncludes,
  sealGrantFromFeed,
  serializeDocument,
  verifyDisclosureReceipt,
  verifyOpeningLocally,
  viewNotesWithKey,
  type ChainLookup,
  type DisclosureReceipt,
  type NoteOpening,
} from "@/lib/shield/disclosure";
import { assertNoSecretLeak } from "@/lib/shield/disclosure/format";
import { scalarToHex } from "@/lib/shield/disclosure/viewing-key";

// ── fixtures ────────────────────────────────────────────────────────────────

const PKG = "0x8ffe0e6f1e8a5d3c4b2a190f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4";
const POOL = "0x1122334455667788990011223344556677889900112233445566778899001122";
const COIN = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdsui::USDSUI";
const DIGEST = "9tPhFmMkR3jXkQ5S3sYzsu2vFq7fRWCLYAJ4Aub1nExample";
const DECIMALS = 6;

function locator(leafIndex: number, txDigest: string | null = DIGEST) {
  return { coinType: COIN, packageId: PKG, poolObjectId: POOL, leafIndex, txDigest };
}

/** A note bound to POOL, with the amount in USDsui micros. */
function noteOf(amountMicros: bigint, pubkey: bigint, blinding: bigint): Note {
  return makeNote({
    amount: amountMicros,
    pubkey,
    blinding,
    pool: poolFieldFromAddress(POOL),
  });
}

/** A `sui_getEvents`-shaped chain fixture for a set of (leaf, commitment). */
function fixtureLookup(
  leaves: Array<{ leafIndex: number; commitment: string }>,
  opts: {
    pkg?: string;
    coinType?: string;
    touched?: string[] | null;
    throwFor?: string;
  } = {}
): ChainLookup {
  return async (txDigest: string) => {
    if (opts.throwFor === txDigest) throw new Error("tx not found");
    return {
      events: leaves.map((l) => ({
        type: `${opts.pkg ?? PKG}::events::NewCommitment<${opts.coinType ?? COIN}>`,
        leafIndex: l.leafIndex,
        commitment: l.commitment,
      })),
      touchedObjectIds: opts.touched === undefined ? [POOL] : opts.touched,
    };
  };
}

/** Deep-walk a document and collect every string value. */
function stringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringValues(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringValues(x, out));
  return out;
}

/** hash3, exactly as the spend path derives it (see sdk/flow.ts nullifierFor). */
function hash3(a: bigint, b: bigint, c: bigint): bigint {
  return poseidonStub([a, b, c]);
}
function nullifierFor(sk: bigint, commitment: bigint, pathIndex: bigint): bigint {
  return hash3(commitment, pathIndex, hash3(sk, commitment, pathIndex));
}

// ── opening proofs ──────────────────────────────────────────────────────────

describe("shield disclosure — opening proofs", () => {
  it("an honest opening verifies offline and anchors on chain", async () => {
    const note = noteOf(2_500_000n, 42n, 987654321n);
    const opening = buildNoteOpening({ note, locator: locator(7), amountDecimals: DECIMALS });

    // The commitment in the document IS hash4 of the revealed tuple.
    expect(opening.commitment).toBe(noteCommitment(note).toString());

    const local = verifyOpeningLocally(opening);
    expect(local.ok).toBe(true);
    expect(local.errors).toEqual([]);
    expect(local.recomputedCommitment).toBe(opening.commitment);

    const receipt = buildDisclosureReceipt({ openings: [opening] });
    const res = await verifyDisclosureReceipt(receipt, {
      chainLookup: fixtureLookup([{ leafIndex: 7, commitment: opening.commitment }]),
    });
    expect(res.ok).toBe(true);
    expect(res.openings[0].chain.status).toBe("verified");
    expect(res.openings[0].chain.poolBinding).toBe("corroborated");
    expect(res.proves[0]).toContain("2.5 USDSUI");
    // Every result states the limits, pass or fail.
    expect(res.doesNotProve.join(" ")).toContain("still unspent");
  });

  it("the owner check turns 'a note exists' into 'a note was paid to this key'", async () => {
    const note = noteOf(2_500_000n, 4242n, 55n);
    const opening = buildNoteOpening({ note, locator: locator(8), amountDecimals: DECIMALS });
    const receipt = buildDisclosureReceipt({ openings: [opening] });
    const chainLookup = fixtureLookup([{ leafIndex: 8, commitment: opening.commitment }]);

    // Without an expected owner: verified, but the caveat is stated.
    const anon = await verifyDisclosureReceipt(receipt, { chainLookup });
    expect(anon.ok).toBe(true);
    expect(anon.openings[0].owner.status).toBe("unchecked");
    expect(anon.doesNotProve.join(" ")).toContain("paid to anyone in particular");

    // With the payee's own key: a stronger claim.
    const mine = await verifyDisclosureReceipt(receipt, {
      chainLookup,
      expectedOwnerPubkey: "4242",
    });
    expect(mine.ok).toBe(true);
    expect(mine.openings[0].owner.status).toBe("matched");
    expect(mine.proves[0]).toContain("addressed to the owner key you supplied");

    // Someone else's key: rejected outright.
    const theirs = await verifyDisclosureReceipt(receipt, {
      chainLookup,
      expectedOwnerPubkey: "4243",
    });
    expect(theirs.openings[0].owner.status).toBe("mismatch");
    expect(theirs.ok).toBe(false);
  });

  it("refuses to build an opening for the wrong pool", () => {
    const wrongPool = noteOf(1n, 1n, 1n);
    expect(() =>
      buildNoteOpening({
        note: { ...wrongPool, pool: wrongPool.pool + 1n },
        locator: locator(0),
        amountDecimals: DECIMALS,
      })
    ).toThrow(/does not match locator.poolObjectId/);
  });

  it("rejects out-of-field and over-u64 values", () => {
    const note = noteOf(1_000n, 5n, 6n);
    const opening = buildNoteOpening({ note, locator: locator(1), amountDecimals: DECIMALS });

    const overField = {
      ...opening,
      note: { ...opening.note, blinding: BN254_SCALAR_FIELD.toString() },
    };
    expect(verifyOpeningLocally(overField).ok).toBe(false);

    const overU64 = { ...opening, note: { ...opening.note, amount: (1n << 70n).toString() } };
    const r = verifyOpeningLocally(overU64);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("u64");
  });

  it("rejects a document with the wrong kind or version", () => {
    const note = noteOf(1n, 2n, 3n);
    const opening = buildNoteOpening({ note, locator: locator(2), amountDecimals: DECIMALS });
    expect(verifyOpeningLocally({ ...opening, kind: "something.else" }).ok).toBe(false);
    expect(verifyOpeningLocally({ ...opening, version: 99 }).ok).toBe(false);
    expect(verifyOpeningLocally({ ...opening, commitment: "0x1f" }).ok).toBe(false);
    expect(verifyOpeningLocally(null).ok).toBe(false);
  });
});

// ── forgery: the negative case that has to hold ─────────────────────────────

describe("shield disclosure — rejects a forged disclosure", () => {
  it("an inflated amount fails the Poseidon opening", async () => {
    const note = noteOf(2_500_000n, 42n, 987654321n);
    const opening = buildNoteOpening({ note, locator: locator(7), amountDecimals: DECIMALS });

    // The forger claims $250 instead of $2.50, keeping the real commitment (it
    // is on chain, so they cannot change it).
    const forged: NoteOpening = {
      ...opening,
      note: { ...opening.note, amount: "250000000" },
    };

    const local = verifyOpeningLocally(forged);
    expect(local.ok).toBe(false);
    expect(local.errors.join(" ")).toContain("commitment mismatch");

    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [forged] }), {
      chainLookup: fixtureLookup([{ leafIndex: 7, commitment: opening.commitment }]),
    });
    expect(res.ok).toBe(false);
    expect(res.openings[0].ok).toBe(false);
    expect(res.proves).toEqual([]);
  });

  it("a tampered blinding fails", () => {
    const note = noteOf(1_000_000n, 9n, 111n);
    const opening = buildNoteOpening({ note, locator: locator(3), amountDecimals: DECIMALS });
    const forged = { ...opening, note: { ...opening.note, blinding: "112" } };
    expect(verifyOpeningLocally(forged).ok).toBe(false);
  });

  it("a swapped commitment fails", () => {
    const a = buildNoteOpening({
      note: noteOf(1n, 1n, 1n),
      locator: locator(0),
      amountDecimals: DECIMALS,
    });
    const b = buildNoteOpening({
      note: noteOf(2n, 2n, 2n),
      locator: locator(1),
      amountDecimals: DECIMALS,
    });
    expect(verifyOpeningLocally({ ...a, commitment: b.commitment }).ok).toBe(false);
  });

  it("a self-consistent but INVENTED note fails the chain anchor", async () => {
    // The forgery that offline checking alone cannot catch: a perfectly valid
    // Poseidon opening of a commitment that was never published.
    const invented = noteOf(100_000_000n, 7n, 424242n);
    const opening = buildNoteOpening({
      note: invented,
      locator: locator(99),
      amountDecimals: DECIMALS,
    });
    expect(verifyOpeningLocally(opening).ok).toBe(true); // offline: consistent

    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }), {
      chainLookup: fixtureLookup([{ leafIndex: 4, commitment: "12345" }]),
    });
    expect(res.ok).toBe(false);
    expect(res.openings[0].chain.status).toBe("not_found");
  });

  it("a real note relocated to another leaf fails as a mismatch", async () => {
    const note = noteOf(500_000n, 3n, 77n);
    const opening = buildNoteOpening({ note, locator: locator(5), amountDecimals: DECIMALS });
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }), {
      chainLookup: fixtureLookup([{ leafIndex: 5, commitment: "999" }]),
    });
    expect(res.openings[0].chain.status).toBe("mismatch");
    expect(res.ok).toBe(false);
  });

  it("a commitment from a DIFFERENT package does not anchor", async () => {
    const note = noteOf(500_000n, 3n, 77n);
    const opening = buildNoteOpening({ note, locator: locator(5), amountDecimals: DECIMALS });
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }), {
      chainLookup: fixtureLookup([{ leafIndex: 5, commitment: opening.commitment }], {
        pkg: "0xdeadbeef",
      }),
    });
    expect(res.openings[0].chain.status).toBe("not_found");
    expect(res.ok).toBe(false);
  });

  it("a receipt with no txDigest cannot be verified, only linted", async () => {
    const note = noteOf(1_000n, 1n, 2n);
    const opening = buildNoteOpening({
      note,
      locator: locator(0, null),
      amountDecimals: DECIMALS,
    });
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }), {
      chainLookup: fixtureLookup([]),
    });
    expect(res.openings[0].local.ok).toBe(true);
    expect(res.openings[0].chain.status).toBe("unchecked");
    expect(res.ok).toBe(false);
  });

  it("offlineOnly can never produce a verified receipt", async () => {
    const note = noteOf(1_000n, 1n, 2n);
    const opening = buildNoteOpening({ note, locator: locator(0), amountDecimals: DECIMALS });
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }), {
      offlineOnly: true,
    });
    expect(res.openings[0].local.ok).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.fullnodeUrl).toBeNull();
  });

  it("one bad opening fails the whole receipt", async () => {
    const good = buildNoteOpening({
      note: noteOf(1_000n, 1n, 2n),
      locator: locator(0),
      amountDecimals: DECIMALS,
    });
    const bad = { ...good, note: { ...good.note, amount: "9999" }, locator: locator(1) };
    const res = await verifyDisclosureReceipt(
      buildDisclosureReceipt({ openings: [good, bad as NoteOpening] }),
      {
        chainLookup: fixtureLookup([
          { leafIndex: 0, commitment: good.commitment },
          { leafIndex: 1, commitment: good.commitment },
        ]),
      }
    );
    expect(res.openings[0].ok).toBe(true);
    expect(res.openings[1].ok).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("a failed chain read is reported as an error, never as a pass", async () => {
    const opening = buildNoteOpening({
      note: noteOf(1_000n, 1n, 2n),
      locator: locator(0),
      amountDecimals: DECIMALS,
    });
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }), {
      chainLookup: fixtureLookup([], { throwFor: DIGEST }),
    });
    expect(res.openings[0].chain.status).toBe("error");
    expect(res.ok).toBe(false);
  });

  it("rejects malformed receipts", async () => {
    expect((await verifyDisclosureReceipt(null)).ok).toBe(false);
    expect((await verifyDisclosureReceipt({ kind: "nope" })).ok).toBe(false);
    const empty = await verifyDisclosureReceipt({
      kind: "talise.shield.disclosure-receipt",
      version: 1,
      openings: [],
    });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(" ")).toContain("non-empty");
  });
});

// ── canonical form + digest ─────────────────────────────────────────────────

describe("shield disclosure — canonical form", () => {
  it("key order does not change the digest", async () => {
    const a = { b: 1, a: "x", c: [1, { z: 1, y: 2 }] };
    const b = { c: [1, { y: 2, z: 1 }], a: "x", b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await documentDigest(a)).toBe(await documentDigest(b));
  });

  it("a receipt digest is stable and changes on any edit", async () => {
    const opening = buildNoteOpening({
      note: noteOf(1_000n, 1n, 2n),
      locator: locator(0),
      amountDecimals: DECIMALS,
    });
    const receipt = buildDisclosureReceipt({
      openings: [opening],
      nowMs: 1_700_000_000_000,
      receiptId: "cafebabecafebabecafebabecafebabe",
    });
    const d1 = await receiptDigest(receipt);
    const d2 = await receiptDigest({ ...receipt });
    expect(d1).toBe(d2);
    const edited: DisclosureReceipt = { ...receipt, memoOverride: "x" } as never;
    expect(await documentDigest(edited)).not.toBe(d1);
  });

  it("refuses to serialise a document carrying spend-authority material", () => {
    expect(() => serializeDocument({ ok: 1, spendingKey: "123" })).toThrow(/spend-authority/);
    expect(() => serializeDocument({ nested: { note_master: "123" } })).toThrow(/spend-authority/);
    expect(() => serializeDocument({ a: [{ sig: "1" }] })).toThrow(/spend-authority/);
    // The blinding is exactly what a disclosure reveals, so it must pass.
    expect(() => serializeDocument({ note: { blinding: "9" } })).not.toThrow();
  });

  it("canonicalJson refuses lossy values", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

// ── scopes ──────────────────────────────────────────────────────────────────

describe("shield disclosure — scopes", () => {
  const row = { leafIndex: 5, commitment: "77", txDigest: "D1", createdAtMs: 1_000 };

  it("evaluates each scope kind", () => {
    expect(scopeIncludes({ type: "account" }, row)).toBe(true);
    expect(scopeIncludes({ type: "notes", commitments: ["77"] }, row)).toBe(true);
    expect(scopeIncludes({ type: "notes", commitments: ["78"] }, row)).toBe(false);
    expect(scopeIncludes({ type: "transaction", txDigests: ["D1"] }, row)).toBe(true);
    expect(scopeIncludes({ type: "transaction", txDigests: ["D2"] }, row)).toBe(false);
    expect(scopeIncludes({ type: "leafRange", fromLeafIndex: 4, toLeafIndex: 5 }, row)).toBe(true);
    expect(scopeIncludes({ type: "leafRange", fromLeafIndex: 6, toLeafIndex: 9 }, row)).toBe(false);
    expect(scopeIncludes({ type: "dateRange", fromMs: 0, toMs: 2_000 }, row)).toBe(true);
    expect(scopeIncludes({ type: "dateRange", fromMs: 2_000, toMs: 3_000 }, row)).toBe(false);
  });

  it("fails CLOSED when the row lacks the field a scope needs", () => {
    const noMeta = { leafIndex: 5, commitment: "77" };
    expect(scopeIncludes({ type: "dateRange", fromMs: 0, toMs: 9e12 }, noMeta)).toBe(false);
    expect(scopeIncludes({ type: "transaction", txDigests: ["D1"] }, noMeta)).toBe(false);
  });
});

// ── viewing grants ──────────────────────────────────────────────────────────

describe("shield disclosure — viewing grants", () => {
  const seed = new Uint8Array(32).fill(7);

  it("a sealed grant carries the in-scope notes and NO key material", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const viewingKey = await deriveViewingKey(kp);

    // Two notes for this account + one for a stranger, all in one feed.
    const mine = [
      noteOf(2_500_000n, kp.publicKey, 111n),
      noteOf(1_000_000n, kp.publicKey, 222n),
    ];
    const theirs = noteOf(9_000_000n, 12345n, 333n);
    const strangerKey = await deriveShieldEncScalar(999n);

    const rows = [
      {
        leafIndex: 0,
        commitment: noteCommitment(mine[0]).toString(),
        txDigest: DIGEST,
        createdAtMs: 1_000,
        encryptedOutput: hex(await encryptNote(mine[0], viewingKey)),
      },
      {
        leafIndex: 1,
        commitment: noteCommitment(theirs).toString(),
        txDigest: DIGEST,
        createdAtMs: 1_000,
        encryptedOutput: hex(await encryptNote(theirs, strangerKey)),
      },
      {
        leafIndex: 2,
        commitment: noteCommitment(mine[1]).toString(),
        txDigest: "OTHER",
        createdAtMs: 5_000,
        encryptedOutput: hex(await encryptNote(mine[1], viewingKey)),
      },
    ];

    // Read works: the viewing key finds this account's notes and nothing else.
    const all = await viewNotesWithKey(viewingKey, rows, { type: "account" });
    expect(all.map((v) => v.row.leafIndex)).toEqual([0, 2]);

    // Scope narrows it to one transaction.
    const grant = await sealGrantFromFeed({
      keypair: kp,
      rows,
      scope: { type: "transaction", txDigests: [DIGEST] },
      coinType: COIN,
      packageId: PKG,
      poolObjectId: POOL,
      amountDecimals: DECIMALS,
      grantedTo: "Auditor LLP",
      purpose: "FY26 review",
    });

    expect(grant.mode).toBe("sealed");
    expect(grant.openings).toHaveLength(1);
    expect(grant.openings[0].note.amount).toBe("2500000");
    // No key material anywhere in the document.
    expect("viewingKeyHex" in grant).toBe(false);
    const values = stringValues(grant);
    expect(values).not.toContain(scalarToHex(viewingKey));
    expect(values).not.toContain(viewingKey.toString());
    expect(values).not.toContain(kp.spendingKey.toString());
    expect(values).not.toContain(scalarToHex(kp.spendingKey));
    // And it survives the leak guard.
    expect(() => serializeDocument(grant)).not.toThrow();

    // The enclosed opening verifies like any other.
    const res = await verifyDisclosureReceipt(
      buildDisclosureReceipt({ openings: grant.openings }),
      {
        chainLookup: fixtureLookup([
          { leafIndex: 0, commitment: grant.openings[0].commitment },
        ]),
      }
    );
    expect(res.ok).toBe(true);
  });

  it("a delegated-key grant demands an explicit acknowledgement", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    await expect(
      buildDelegatedKeyViewingGrant({
        keypair: kp,
        scope: { type: "account" },
        coinType: COIN,
        packageId: PKG,
        poolObjectId: POOL,
        // @ts-expect-error the type demands `true`; the runtime check backs it up
        acknowledgeAccountWide: false,
      })
    ).rejects.toThrow(/acknowledgeAccountWide/);
  });

  it("a delegated-key grant says out loud that its scope is advisory", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const grant = await buildDelegatedKeyViewingGrant({
      keypair: kp,
      scope: { type: "dateRange", fromMs: 0, toMs: 1 },
      coinType: COIN,
      packageId: PKG,
      poolObjectId: POOL,
      acknowledgeAccountWide: true,
    });
    expect(grant.notice).toMatch(/advisory only/);
    expect(grant.notice).toMatch(/cannot be revoked/);
    expect(grant.statement).toMatch(/advisory/);
  });
});

// ── the invariant: a viewing key cannot spend ───────────────────────────────

describe("shield disclosure — a viewing key cannot spend", () => {
  const seed = new Uint8Array(32).fill(3);

  it("the granted key is not the spending key, and no grant contains one", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const viewingKey = await deriveViewingKey(kp);
    expect(viewingKey).not.toBe(kp.spendingKey);

    const grant = await buildDelegatedKeyViewingGrant({
      keypair: kp,
      scope: { type: "account" },
      coinType: COIN,
      packageId: PKG,
      poolObjectId: POOL,
      acknowledgeAccountWide: true,
    });

    // The document carries the VIEWING scalar and nothing else secret.
    expect(grant.viewingKeyHex).toBe(scalarToHex(viewingKey));
    const values = stringValues(grant);
    expect(values).not.toContain(kp.spendingKey.toString());
    expect(values).not.toContain(scalarToHex(kp.spendingKey));
    expect(values).not.toContain(kp.viewingKey.toString());
  });

  it("an opened grant exposes no spend authority, by shape", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const grant = await buildDelegatedKeyViewingGrant({
      keypair: kp,
      scope: { type: "account" },
      coinType: COIN,
      packageId: PKG,
      poolObjectId: POOL,
      acknowledgeAccountWide: true,
    });
    const opened = openGrant(grant);
    expect(Object.keys(opened).sort()).toEqual(
      ["capabilities", "decryptScalar", "expired", "mode", "openings", "scope"].sort()
    );
    expect("spendingKey" in opened).toBe(false);
    expect("noteMaster" in opened).toBe(false);
    expect(opened.capabilities).not.toContain("spend");
    expect(grantConfersSpendAuthority(grant)).toBe(false);
    expect(grantConfersSpendAuthority(opened)).toBe(false);
  });

  it("the grantee can READ a note but cannot produce its nullifier", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const viewingKey = await deriveViewingKey(kp);
    const note = noteOf(2_500_000n, kp.publicKey, 4242n);
    const commitment = noteCommitment(note);
    const leafIndex = 11n;

    const rows = [
      {
        leafIndex: Number(leafIndex),
        commitment: commitment.toString(),
        txDigest: DIGEST,
        createdAtMs: 1,
        encryptedOutput: hex(await encryptNote(note, viewingKey)),
      },
    ];

    // READ: works.
    const seen = await viewNotesWithKey(viewingKey, rows, { type: "account" });
    expect(seen).toHaveLength(1);
    expect(seen[0].note.amount).toBe(2_500_000n);

    // SPEND: the pool consumes `nullifier = hash3(c, i, hash3(sk, c, i))`.
    // Only the spending key produces it.
    const real = nullifierFor(kp.spendingKey, commitment, leafIndex);

    // Everything the grantee holds, tried as if it were the spending key.
    const grant = await buildDelegatedKeyViewingGrant({
      keypair: kp,
      scope: { type: "account" },
      coinType: COIN,
      packageId: PKG,
      poolObjectId: POOL,
      acknowledgeAccountWide: true,
    });
    const opened = openGrant(grant);
    const candidates = [
      opened.decryptScalar!, // the granted viewing key
      kp.viewingKey, // == publicKey, see the note below
      kp.publicKey,
      note.blinding, // revealed by the disclosure
      note.pubkey,
      note.amount,
      commitment,
    ];
    for (const c of candidates) {
      // Reduce into the BN254 field first — the ECIES scalar lives mod the
      // P-256 group order and can exceed r, which Poseidon rejects outright.
      const reduced = c % BN254_SCALAR_FIELD;
      expect(nullifierFor(reduced, commitment, leafIndex)).not.toBe(real);
    }
  });

  it("ShieldKeypair.viewingKey is the PUBLIC owner key, not the decryption key", async () => {
    // A naming trap worth pinning down: `ShieldKeypair.viewingKey` is
    // Poseidon1(spendingKey) — the SAME value as `publicKey`, i.e. the note
    // owner field that is already bound into every commitment. It is public and
    // grants nothing. The real read capability is the ECIES enc scalar, which is
    // what `deriveViewingKey` returns and what a grant carries. Anyone reaching
    // for `kp.viewingKey` to build a grant would be handing over a public value.
    const kp = await deriveShieldKeypairFromSeed(seed);
    expect(kp.viewingKey).toBe(kp.publicKey);
    const granted = await deriveViewingKey(kp);
    expect(granted).not.toBe(kp.viewingKey);
    expect(granted).not.toBe(kp.spendingKey);
  });

  it("a receipt reveals no material that could authorise a spend", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const note = noteOf(1_500_000n, kp.publicKey, 5150n);
    const receipt = buildDisclosureReceipt({
      openings: [buildNoteOpening({ note, locator: locator(1), amountDecimals: DECIMALS })],
      disclosedBy: { label: "Acme Ltd", suiAddress: null },
    });
    const values = stringValues(receipt);
    expect(values).not.toContain(kp.spendingKey.toString());
    const encScalar = await deriveShieldEncScalar(kp.spendingKey);
    expect(values).not.toContain(encScalar.toString());
    expect(values).not.toContain(scalarToHex(encScalar));
    // `note.pubkey` IS in the receipt — it is the note's public owner field
    // (== kp.viewingKey == kp.publicKey), and revealing it is the point.
    expect(values).toContain(kp.publicKey.toString());
    // And the guard would have caught a stray field anyway.
    expect(() => assertNoSecretLeak(receipt)).not.toThrow();
  });

  it("assertGrantCarriesNoSpendAuthority catches a hand-assembled bad grant", async () => {
    const kp = await deriveShieldKeypairFromSeed(seed);
    const good = await buildDelegatedKeyViewingGrant({
      keypair: kp,
      scope: { type: "account" },
      coinType: COIN,
      packageId: PKG,
      poolObjectId: POOL,
      acknowledgeAccountWide: true,
    });
    // Somebody hand-edits the SPENDING key into the grant.
    const bad = { ...good, viewingKeyHex: scalarToHex(kp.spendingKey) };
    const { assertGrantCarriesNoSpendAuthority } = await import(
      "@/lib/shield/disclosure/viewing-key"
    );
    expect(() => assertGrantCarriesNoSpendAuthority(bad, kp)).toThrow(/SPENDING key/);
    expect(() => assertGrantCarriesNoSpendAuthority(good, kp)).not.toThrow();

    // A grant claiming a capability outside the read-only set is rejected too.
    const overreach = { ...good, capabilities: ["spend"] } as never;
    expect(() => assertGrantCarriesNoSpendAuthority(overreach, kp)).toThrow(/read-only/);
  });

  it("a sealed grant with no openings is refused (no empty disclosures)", () => {
    expect(() =>
      buildSealedViewingGrant({
        scope: { type: "account" },
        openings: [],
        coinType: COIN,
        packageId: PKG,
        poolObjectId: POOL,
      })
    ).toThrow(/at least one opening/);
  });
});

function hex(b: Uint8Array): string {
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── against REAL mainnet chain data ─────────────────────────────────────────
//
// The `talise_privacy` pilot package published real `NewCommitment` events on
// Sui mainnet. These tests point the DEFAULT JSON-RPC chain reader at a public
// fullnode and check the anchor half of the verifier against them. Read-only:
// two RPC reads, no transaction, no keys.
//
// The important one is the forgery: an attacker with FULL access to public chain
// data (they can read every commitment) still cannot fabricate an amount,
// because they do not hold the note's blinding factor.

const REAL = {
  packageId: "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf",
  poolObjectId: "0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1",
  coinType: "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
  txDigest: "9vdd9DPhGw6o9i4roLYHGGYu18TwMsAHszjjygQyQccM",
  leafIndex: 0,
  commitment: "12083756045566619342482386435791506046780346924114394862426103012937129171996",
} as const;

/** An opening claiming a REAL on-chain commitment with a made-up preimage. */
function forgedOverRealCommitment(claimMicros: string): NoteOpening {
  const pool = poolFieldFromAddress(REAL.poolObjectId);
  return {
    kind: "talise.shield.note-opening",
    version: 1,
    commitment: REAL.commitment,
    note: { amount: claimMicros, pubkey: "1", blinding: "2", pool: pool.toString() },
    locator: {
      coinType: REAL.coinType,
      packageId: REAL.packageId,
      poolObjectId: REAL.poolObjectId,
      leafIndex: REAL.leafIndex,
      txDigest: REAL.txDigest,
    },
    amountDecimals: 6,
    memo: null,
  };
}

describe("shield disclosure — against real mainnet chain data", () => {
  it("finds a real commitment on chain and corroborates the pool", async () => {
    const receipt = buildDisclosureReceipt({
      openings: [forgedOverRealCommitment("1000000")],
    });
    const res = await verifyDisclosureReceipt(receipt);
    // The anchor half succeeds: that commitment IS at that leaf in that tx.
    expect(res.openings[0].chain.status).toBe("verified");
    expect(res.openings[0].chain.poolBinding).toBe("corroborated");
  });

  it("a forged amount over a REAL commitment is rejected", async () => {
    // Full public-chain knowledge is not enough to lie about an amount: without
    // the blinding factor no attacker can produce a tuple that hashes to a
    // commitment the pool already published.
    const receipt = buildDisclosureReceipt({
      openings: [forgedOverRealCommitment("999000000")],
    });
    const res = await verifyDisclosureReceipt(receipt);
    expect(res.openings[0].chain.status).toBe("verified"); // anchor fine
    expect(res.openings[0].local.ok).toBe(false); // opening is a lie
    expect(res.openings[0].local.errors.join(" ")).toContain("commitment mismatch");
    expect(res.ok).toBe(false);
    expect(res.proves).toEqual([]);
  });

  it("a real commitment moved to the wrong leaf is caught", async () => {
    const opening = { ...forgedOverRealCommitment("1000000") };
    opening.locator = { ...opening.locator, leafIndex: 1 };
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }));
    // Leaf 1 of that tx holds a DIFFERENT commitment.
    expect(res.openings[0].chain.status).toBe("mismatch");
    expect(res.ok).toBe(false);
  });

  it("an unknown transaction digest fails the anchor", async () => {
    const opening = { ...forgedOverRealCommitment("1000000") };
    opening.locator = {
      ...opening.locator,
      txDigest: "11111111111111111111111111111111111111111111",
    };
    const res = await verifyDisclosureReceipt(buildDisclosureReceipt({ openings: [opening] }));
    expect(["error", "not_found"]).toContain(res.openings[0].chain.status);
    expect(res.ok).toBe(false);
  });
});
