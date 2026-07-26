# Selective disclosure for the Talise shielded pool

**Status:** built, gated OFF. Every surface sits behind `SHIELD_MAINTENANCE`,
which is currently `true`. Nothing here has been used against real money.

**What this is for.** A shielded payment hides the amount from everyone. That is
useless to a licensed payments business unless it can also *prove* a specific
payment happened — to a counterparty chasing an invoice, to an auditor, to a
regulator — without publishing its whole financial life. Selective disclosure is
that bridge.

**Why it was cheap to build.** It needs no trusted setup, no ceremony output, no
Groth16 verifying key, and no on-chain change. The pool already publishes a
Poseidon commitment per note; a disclosure is just its preimage. The only
cryptographic assumption is Poseidon-BN254 collision resistance, which the pool
already rests on entirely.

---

## 1. The three documents

| kind | contains | who reads it |
| --- | --- | --- |
| `talise.shield.note-opening/1` | one note's `(amount, pubkey, blinding, pool)` + its on-chain locator | the atom; embedded in the two below |
| `talise.shield.disclosure-receipt/1` | a bundle of openings + a scope + a notice | counterparty, auditor, regulator |
| `talise.shield.viewing-grant/1` | scoped read access: **sealed** (openings, no keys) or **delegated-key** (the account viewing key) | auditor under engagement |

All three are plain JSON with every field element as a decimal string, and all
three canonicalise the same way (`canonicalJson`: keys sorted at every depth, no
whitespace) so a receipt has exactly one SHA-256 digest no matter who serialised
it. Quote that digest when you refer to a receipt.

There is **no Talise signature** anywhere in these formats, deliberately. A
signature would invite the reader to trust Talise instead of the chain, which is
backwards. The binding is the on-chain commitment.

Code: `lib/shield/disclosure/{format,open,receipt,verify,viewing-key}.ts`.

---

## 2. What an opening proves

The pool stores each note as a Merkle leaf

```
commitment = hash4(amount, pubkey, blinding, pool)      // Poseidon-BN254, arity 4
```

and emits it in `events::NewCommitment<CoinType> { index, commitment, encrypted_output }`.
An opening reveals the tuple. A verifier does two independent things:

1. **Offline** (`verifyOpeningLocally`) — recompute `hash4` over the revealed
   tuple and compare to the claimed commitment; check every field is in the
   BN254 scalar field, the amount fits `u64`, and `pool == poolObjectId mod r`.
2. **On chain** (`verifyDisclosureReceipt`) — fetch the named transaction from a
   fullnode *the verifier chooses* and confirm a `NewCommitment` event from the
   named package carries that exact commitment at that exact leaf index. Also
   corroborate that the named pool object took part in the transaction.

**Both halves are required.** Offline alone is worthless: anyone can invent
`(amount, pubkey, blinding)` and publish its hash. On-chain alone is worthless: a
commitment says nothing about the amount inside it. Together, and only together:

> A note of exactly `amount` units of `coinType`, owned by owner key `pubkey`,
> exists as leaf `index` of pool `poolObjectId`, created by transaction `digest`.

### With an owner key supplied, it proves more

Pass `expectedOwnerPubkey` and the claim becomes *"…and it is addressed to this
owner key."* This matters more than it looks. **The payer also knows the
blinding** — they chose it when they built the output note. So without an owner
check, a payer can open a note they created **for themselves** and present it as
a payment. A payee verifying a receipt should always pass their own pubkey. A
third-party auditor can only pass a pubkey they have been *told* belongs to a
party, which is an out-of-band claim (see §6).

### What it does not prove, ever

- **Not "unspent."** The nullifier is `hash3(commitment, index, sig)` where
  `sig = hash3(spendingKey, commitment, index)`. An opening never contains
  `spendingKey`, so the nullifier is not derivable from a receipt and the spent
  set cannot be checked from one. See §7 for the analysed-and-rejected extension.
- **Not "sent by X."** The pool binds no sender into a note, and the on-chain
  transaction sender is the **gas relayer**, not the payer.
- **Not an identity.** `pubkey` is a field element. Binding it to a legal person
  is out of band.
- **Not completeness.** A receipt says nothing about the notes you did not list.
  No scope can turn it into a proof of absence.
- **Not authorship.** `disclosedBy` is unauthenticated free text.

`verifyDisclosureReceipt` returns these as `doesNotProve` on **every** result,
pass or fail, and the CLI and UI both print them. That is intentional — the
failure mode of a receipt is a reader over-reading it.

---

## 3. Verifying without trusting Talise

This is the point of the feature, so it has three independent paths, in
descending order of trust-minimisation:

**1. Run the verifier yourself (recommended).**

```
cd web
node --loader ./scripts/shield-node-loader.mjs \
     scripts/verify-shield-disclosure.mjs receipt.json \
     --fullnode https://your-own-node.example \
     --owner <your-owner-pubkey>
```

Exit code 0 iff every opening verified. `lib/shield/disclosure/verify.ts` has no
`server-only` import and no Node-only dependency, so you can also just
`import { verifyDisclosureReceipt }` into your own tooling. Its only
dependency for the hash is `@mysten/sui`'s `poseidonHash`, the circomlib
parameterisation that is byte-identical to `sui::poseidon_bn254`.

**2. Verify in your own browser tab** at `/app/private/disclose`. The page is
served by Talise but the verification runs client-side against a fullnode you
type in. Weaker than (1) — you are trusting the page you were served.

**3. `POST /api/shield/disclose/verify`.** A convenience for someone who will not
run code. It is the weakest option and says so: the response always carries a
`trustNote` telling the caller how to check the answer themselves. The fullnode
host is allowlisted here (an arbitrary caller-supplied URL would be an SSRF
pivot); if you want your own node, use (1).

**Trust surface of path (1):** the fullnode, for "these events exist in this
transaction", and nothing else. A verifier who does not want to trust one node
can re-run against several and require agreement.

---

## 4. Viewing keys: what a grant can and cannot do

Two modes, and the difference is the most important thing on this page.

### `sealed` — the default, and what you almost always want

Contains **no key material at all**. It carries the already-opened notes for
exactly the scope stated. The scope is therefore **cryptographically exact**:
nothing outside it is present in the document, so nothing outside it is
derivable. A sealed grant cannot see the future, cannot be widened, and cannot be
re-scoped by its holder. Use it for "prove this invoice was paid".

### `delegated-key` — powerful, and effectively permanent

Contains the account's **ECIES note-decryption scalar**. It cannot spend (below),
but understand what it *is*:

- **The stated scope is advisory only.** This SDK (`viewNotesWithKey`) and
  Talise's routes honour it. A grantee running their own code does not have to:
  the key decrypts every ciphertext for this account that they can fetch,
  including notes created **after** the grant was issued. Model it as
  account-wide.
- **`expiresAtMs` is advisory too.** Nothing on chain enforces it.
- **It cannot be revoked.** See §5.

The builder refuses to produce one unless the caller passes
`acknowledgeAccountWide: true`.

### CAN

- trial-decrypt `encrypted_output0/1` blobs → learn `(amount, pubkey, blinding, pool)`
  for notes addressed to the account;
- recompute commitments, so confirm which on-chain leaves belong to the account;
- build openings and receipts for those notes;
- watch the commitment feed for new incoming notes (delegated-key only).

### CANNOT

- **spend.** A spend needs the nullifier
  `hash3(commitment, index, hash3(spendingKey, commitment, index))` *and* a
  Groth16 proof whose witness includes `spendingKey` — the circuit derives
  `pubkey = hash1(spendingKey)` and enforces the commitment against it
  (`move/talise-privacy/circuit/src/circuit/mod.rs`). The viewing key is
  `d = SHA-256("talise.shield.enc-scalar.v1" ‖ spendingKey) mod n`: a one-way
  function *of* the spending key, not a route back to it. **Named assumption:**
  handing out `d` cannot yield spend authority unless SHA-256 is invertible.
- sign a transaction, authorise a withdrawal, or change any account setting.
- derive the spending key or any other note's secret beyond what it can decrypt.

### Accident-proofing (you cannot hand over a spending key by mistake)

- Grant builders take the whole `ShieldKeypair` and derive the viewing key
  themselves. **There is no code path that accepts a raw "key" from a caller and
  copies it into a grant.**
- `deriveViewingKey` asserts the derived scalar is not the spending key.
- `assertGrantCarriesNoSpendAuthority` re-checks a finished grant (including a
  hand-assembled one) and rejects a capability outside the read-only set.
- `serializeDocument` runs `assertNoSecretLeak`, which refuses to serialise any
  document containing a field named like spend-authority material
  (`spendingKey`, `noteMaster`, `seed`, `mnemonic`, `sig`, …). `blinding` is
  deliberately *not* on that list — it is the thing being disclosed.
- `openGrant` returns an object with no `spendingKey` property **by type**.
- `grantConfersSpendAuthority()` returns `false` as a callable, tested statement
  of the invariant, so a refactor that broke it would break a test.

### A naming trap, pinned by a test

`ShieldKeypair.viewingKey` is **not** the note-decryption key. It is
`Poseidon1(spendingKey)` — the *same value* as `publicKey`, i.e. the note owner
field already bound into every commitment. It is public and grants nothing.
Reaching for it to build a grant would hand over a public value (harmless, but
useless). The real read capability is the ECIES scalar from
`deriveShieldEncScalar` / `deriveViewingKey`. Test:
*"ShieldKeypair.viewingKey is the PUBLIC owner key, not the decryption key"*.

---

## 5. What a disclosure irreversibly leaks

**A disclosure is a deanonymisation of that note, by design. Say so to users.**

1. **The amount, permanently.** Whoever holds the receipt can link that exact
   amount to that exact on-chain commitment forever. There is no expiry.
2. **No revocation. None.** There is no on-chain revocation list, no key
   rotation for existing notes, and no way to un-publish a blinding factor. Once
   revealed, revealed. `expiresAtMs` on a grant is a courtesy string.
3. **The owner key — which is a stable account identifier.** `pubkey =
   Poseidon1(spendingKey)` is **constant across every note the account ever
   owns**. Consequences:
   - **Two receipts from the same account are linkable to each other** by their
     shared `pubkey`, even if issued years apart to different parties.
   - `/api/recipient/resolve` returns a recipient's shield `pubkey` for a given
     Sui address to any authenticated Talise user, and `shield_identity` stores
     that mapping. So a disclosed `pubkey` can be **matched back to a Sui address
     and hence a Talise account** by anyone who can query that directory or the
     database. In practice, disclosing one note tells a determined reader *which
     account* the note belongs to.
   - This is the single biggest leak in the design, and it is a property of the
     existing key schedule, not of disclosure. Per-note (diversified) owner keys
     would fix it — see §7, proposal 3. **Do not tell users a disclosure is
     limited to one payment; tell them it identifies the account.**
4. **Everything a *sealed grant's* scope contains,** and nothing more.
   Everything a *delegated key* can reach — which is the whole account, forever.
5. **Nothing about other notes,** cryptographically. A receipt is not a window
   into the rest of the account. (Point 3 is about linking accounts, not amounts.)

---

## 6. How this interacts with the pool's known open gaps

Selective disclosure sits on top of a privacy layer that is currently weak in
ways that have nothing to do with disclosure. Being precise about this matters,
because the marginal harm of a disclosure depends entirely on it.

| gap | state today | effect on disclosure |
| --- | --- | --- |
| **Anonymity set ≈ 1** | Measured on mainnet 2026-07-26: the pilot pool (`0x6bcd…52c1`) has **86 leaves** total (`next_index = 86`, matching the indexer) across a handful of pilot transactions, and sends are locked. Two leaves are emitted per `transact`, and about half the pool's history is the operator's own harness runs. With a set that small, an observer correlating deposit/withdraw amounts and timing can often deanonymise a payment *without* any disclosure. | Today a disclosure adds little the chain does not already give away. **This inverts as the set grows**: the larger the anonymity set, the more a disclosure is the *only* thing that breaks it, and the more it costs. Design for the future case. |
| **The relayer sees the sender→recipient link** | `/api/shield/relay` is called by an authenticated user and, for a withdraw, is handed the exit address for compliance screening. For an internal transfer the sender first resolves the recipient through `/api/recipient/resolve`. Either way Talise learns *who asked to pay whom*. | A disclosure adds the **amount** to a link Talise already holds. For third parties it adds both. Do not describe a receipt as "the only way anyone learns this" — the relayer already knows the parties. |
| **Deposits and withdrawals reveal amounts inherently** | `ExtData.value` is cleartext for the public leg, as is `relayer_fee`. Only *internal* transfers have a hidden amount (`public_value = 0`). | A receipt for a note created by a deposit or consumed by a withdraw discloses an amount that is **already public on chain**. The genuinely new information is confined to internal transfers. Worth surfacing in the UI eventually. |
| **Nullifier events are public** | `NullifierSpent` is emitted per spend, so the *count* of spends is public; linking a nullifier to a commitment is not possible without the spending key. | A receipt cannot prove unspent-ness (§2). It also does not help an observer link nullifiers — unless a `sig` is revealed, which we do not do (§7). |
| **Operator-secured proving key, ceremony pending** | Groth16 setup is not yet a multi-party ceremony. | **Disclosure is unaffected.** It touches no Groth16 artefact. A compromised proving key would let someone mint fake notes, and such a note *could* then be opened — so disclosure inherits soundness from the pool, but adds no new dependency on the ceremony. |
| **Pilot cap `$2.50/tx`** | Enforced elsewhere. | Bounds the amount any single receipt can attest to. |

---

## 7. On-chain changes proposed, and deliberately **not** made

No Move source was touched and no transaction was submitted. These are written up
for whoever owns the pool.

1. **`events::DisclosureAnchor { digest: vector<u8>, discloser: address }`** —
   one optional, user-initiated event publishing the SHA-256 of a canonical
   receipt. Cost: one event, no verifier, no ceremony. Buys two things a receipt
   cannot get off-chain: a **chain timestamp** (a receipt cannot be backdated)
   and **non-repudiation** (the discloser cannot later deny issuing it). This is
   the highest value-per-byte on-chain change available.

2. **Emit the pool address inside `NewCommitment`.** Today a verifier confirms
   the pool binding two ways: the note's own `pool` field (checked offline,
   authoritative) and by observing that the pool object took part in the
   transaction (`sui_getTransactionBlock`, corroborating, and reported as
   `unavailable` when a node declines the call). Emitting `pool: address` in the
   event would make it a single clean check with no second RPC.

3. **Diversified (per-note) owner keys.** The fix for §5.3. Replace
   `pubkey = hash1(spendingKey)` with `pubkey = hash2(spendingKey, diversifier)`
   so a disclosed note does not carry a stable account identifier. This is a
   **circuit + verifying-key + SDK change** and it would orphan every existing
   note, so it belongs in a v2 alongside the ceremony — not as a patch. Flagging
   it because it is the difference between "this disclosure reveals one payment"
   and "this disclosure reveals which account made it".

4. **An opt-in on-chain `verify_opening`** using `sui::poseidon::poseidon_bn254`,
   so a Move module (escrow, invoice, milestone release) could take a disclosure
   as a precondition. Feasible today with zero new cryptography. **But it puts
   the blinding factor on chain publicly**, i.e. maximal, permanent, worldwide
   deanonymisation of that note — strictly worse than handing a JSON file to one
   party. Only ever as an explicit opt-in for a note created for that purpose.

5. **Proving "unspent" needs a new circuit — analysed and rejected for now.**
   A holder *can* reveal `sig = hash3(spendingKey, commitment, index)` without
   revealing `spendingKey` (Poseidon is one-way) and without conferring spend
   authority (the circuit needs `spendingKey` as a witness to satisfy
   `pubkey = hash1(spendingKey)`; `sig` alone cannot). A verifier could then
   compute the nullifier and check the spent set. **It does not work, and the
   asymmetry is the reason:**
   - nullifier **present** in the spent set ⇒ the note is genuinely spent (a
     forger could not find a `sig` hitting an existing nullifier);
   - nullifier **absent** ⇒ either unspent *or* the `sig` was fabricated. A
     malicious discloser supplies a random `sig`, gets a nullifier that will
     never appear, and "proves" unspent-ness forever.

   So this construction can prove *spent* but not *unspent*, which is the wrong
   direction for a payment receipt. It also leaks: a genuine `sig` lets the
   receipt holder watch the chain and learn exactly when the note is spent.
   **Not implemented.** A sound unspent-ness proof needs its own circuit and its
   own trusted setup — precisely the cost this work was chosen to avoid.

---

## 8. Operational rules

- **A disclosure is always an explicit, per-note user action.** Never a default,
  never implicit, never on a timer. The UI requires an un-prechecked
  acknowledgement that the act is permanent before it will build a receipt.
- **The note secret never leaves the holder's device.** Receipts are built
  client-side. `/api/shield/disclose/locator` returns only data that is already
  public (leaf index, transaction digest, timestamp) and receives no secret.
  `/api/shield/disclose/verify` receives a receipt the *counterparty* chose to
  send us, and it logs nothing and persists nothing.
- **Nothing logs or persists a spending key, a note master, or a blinding
  factor.** The verify route deliberately does not echo request content into
  logs, because an error string could carry an amount.
- **Everything is behind `SHIELD_MAINTENANCE`.** Both routes 503 while it is on;
  the page renders as an explainer only.

## 9. Tests

`web/__tests__/sui/shield-disclosure.test.ts` — 36 tests. Highlights:

- honest opening verifies offline and anchors on chain; forged amount, tampered
  blinding, swapped commitment, invented note, relocated leaf, wrong package,
  missing digest, failed chain read, and one-bad-opening-in-a-bundle all fail;
- **against real mainnet data**: a real `NewCommitment` from the pilot package is
  found and its pool corroborated, and a receipt claiming `999.00` over that
  *real* commitment is rejected — an attacker with full public-chain knowledge
  still cannot fabricate an amount without the blinding;
- a viewing key reads notes but **cannot** produce the nullifier a spend needs,
  for any candidate value it holds; an opened grant has no spend field by shape;
  a hand-edited grant carrying the spending key is refused;
- canonical form is order-independent and digest-stable; the leak guard refuses
  spend-authority field names; scopes fail closed when a row lacks the field
  they need.

Run: `cd web && npx vitest run --config vitest.integration.config.ts __tests__/sui/shield-disclosure.test.ts`
