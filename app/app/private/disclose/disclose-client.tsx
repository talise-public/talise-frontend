"use client";

import { useState } from "react";
import {
  DEFAULT_FULLNODE_URL,
  buildDisclosureReceipt,
  buildNoteOpening,
  poolFieldFromAddress,
  receiptFilename,
  receiptToPrettyJson,
  verifyDisclosureReceipt,
  type NoteLocator,
  type ReceiptVerification,
} from "@/lib/shield/disclosure";

/**
 * Client half of /app/private/disclose. Two panels:
 *
 *   OPEN   — turn a note you hold into a disclosure receipt. Requires the note's
 *            secret (amount, owner pubkey, blinding), which only the holder has.
 *            Behind an explicit, un-prechecked confirmation, because the act is
 *            irreversible.
 *   VERIFY — check a receipt someone handed you. Runs ENTIRELY in this tab
 *            against a fullnode you name; no Talise endpoint is called. That is
 *            deliberate: a disclosure you have to trust us about is worthless.
 *
 * The note secret never leaves the browser. Nothing here POSTs a blinding factor
 * anywhere, and nothing is stored.
 */

const DISPLAY = {
  fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
} as const;

const CARD =
  "rounded-[28px] bg-[#f7fcf2] p-7 shadow-[0_1px_2px_rgba(18,26,15,0.04),0_14px_34px_-22px_rgba(18,26,15,0.22)]";
const INPUT =
  "w-full rounded-2xl border border-[#dbead2] bg-white px-4 py-3 font-mono text-[13px] text-[#15300c] outline-none placeholder:text-[#9bb392] focus:border-[#8fc47a]";
const LABEL = "mb-1.5 block font-mono text-[10px] uppercase tracking-[0.22em] text-[#3d7a29]";
const BTN =
  "rounded-full bg-[#15300c] px-5 py-2.5 text-[14px] font-[500] text-[#f7fcf2] transition disabled:cursor-not-allowed disabled:opacity-40";
const BTN_ALT =
  "rounded-full border border-[#15300c]/20 bg-transparent px-5 py-2.5 text-[14px] font-[500] text-[#15300c] transition disabled:cursor-not-allowed disabled:opacity-40";

export function DiscloseClient(props: {
  live: boolean;
  packageId: string;
  poolObjectId: string;
  coinType: string;
  amountDecimals: number;
}) {
  return (
    <div className="space-y-7">
      <VerifyPanel />
      <OpenPanel {...props} />
    </div>
  );
}

// ── verify ─────────────────────────────────────────────────────────────────

function VerifyPanel() {
  const [text, setText] = useState("");
  const [fullnode, setFullnode] = useState(DEFAULT_FULLNODE_URL);
  const [ownerPubkey, setOwnerPubkey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReceiptVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsed = JSON.parse(text) as unknown;
      const res = await verifyDisclosureReceipt(parsed, {
        fullnodeUrl: fullnode.trim(),
        expectedOwnerPubkey: ownerPubkey.trim() || undefined,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={CARD}>
      <h2 className="mb-1.5 text-[20px] font-[500] tracking-[-0.04em] text-[#15300c]" style={DISPLAY}>
        Check a receipt
      </h2>
      <p className="mb-5 text-[14px] leading-relaxed text-[#3a5230]">
        Paste a disclosure receipt. It is checked in this browser tab, against the
        fullnode below — no Talise server is involved in the verdict, so you do
        not have to take our word for it.
      </p>

      <label className={LABEL} htmlFor="receipt-json">
        Receipt JSON
      </label>
      <textarea
        id="receipt-json"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        spellCheck={false}
        placeholder='{ "kind": "talise.shield.disclosure-receipt", … }'
        className={`${INPUT} resize-y`}
      />

      <div className="mt-4">
        <label className={LABEL} htmlFor="fullnode">
          Sui fullnode (yours, if you have one)
        </label>
        <input
          id="fullnode"
          value={fullnode}
          onChange={(e) => setFullnode(e.target.value)}
          spellCheck={false}
          className={INPUT}
        />
      </div>

      <div className="mt-4">
        <label className={LABEL} htmlFor="owner-pubkey">
          Your owner pubkey (optional, but it is what turns &ldquo;a note
          exists&rdquo; into &ldquo;a note was paid to me&rdquo;)
        </label>
        <input
          id="owner-pubkey"
          value={ownerPubkey}
          onChange={(e) => setOwnerPubkey(e.target.value)}
          spellCheck={false}
          placeholder="decimal field element"
          className={INPUT}
        />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button type="button" className={BTN} disabled={busy || !text.trim()} onClick={run}>
          {busy ? "Checking…" : "Check against Sui"}
        </button>
        {result ? (
          <span
            className={`font-mono text-[11px] uppercase tracking-[0.22em] ${
              result.ok ? "text-[#2f6b1f]" : "text-[#a12f1f]"
            }`}
          >
            {result.ok ? "Verified" : "Not verified"}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-4 rounded-2xl bg-[#fff2ef] px-4 py-3 text-[13px] text-[#a12f1f]">
          {error}
        </p>
      ) : null}

      {result ? <VerifyResult result={result} /> : null}
    </section>
  );
}

function VerifyResult({ result }: { result: ReceiptVerification }) {
  return (
    <div className="mt-6 space-y-4">
      <dl className="grid grid-cols-1 gap-2 font-mono text-[11px] text-[#3a5230] sm:grid-cols-2">
        <div>
          <dt className="uppercase tracking-[0.2em] text-[#3d7a29]">Receipt digest</dt>
          <dd className="break-all">{result.receiptDigest ?? "—"}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-[0.2em] text-[#3d7a29]">Fullnode consulted</dt>
          <dd className="break-all">{result.fullnodeUrl ?? "none (offline)"}</dd>
        </div>
      </dl>

      {result.errors.length ? (
        <ul className="space-y-1 text-[13px] text-[#a12f1f]">
          {result.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      <ol className="space-y-3">
        {result.openings.map((o, i) => (
          <li key={`${o.commitment}-${i}`} className="rounded-2xl bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#3d7a29]">
                Note {i + 1}
              </span>
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.22em] ${
                  o.ok ? "text-[#2f6b1f]" : "text-[#a12f1f]"
                }`}
              >
                {o.ok ? "pass" : "fail"}
              </span>
            </div>
            {o.statement ? (
              <p className="mb-2 text-[13px] leading-relaxed text-[#15300c]">
                {/* Labelled as the receipt's CLAIM when it failed, so a failing
                    sentence can never read as a verified finding. */}
                <span className="mr-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d7a29]">
                  {o.ok ? "verified" : "claimed, unverified"}
                </span>
                {o.statement}
              </p>
            ) : null}
            <ul className="space-y-1 font-mono text-[11px] text-[#3a5230]">
              <li>opening (Poseidon preimage): {o.local.ok ? "pass" : "fail"}</li>
              {o.local.errors.map((e) => (
                <li key={e} className="text-[#a12f1f]">
                  — {e}
                </li>
              ))}
              <li>
                chain anchor: {o.chain.status} — {o.chain.detail}
              </li>
              <li>pool binding: {o.chain.poolBinding}</li>
              <li>
                addressed to you: {o.owner.status} — {o.owner.detail}
              </li>
            </ul>
          </li>
        ))}
      </ol>

      {result.ok ? (
        <div>
          <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-[#3d7a29]">
            Proves
          </h4>
          <ul className="space-y-1 text-[13px] leading-relaxed text-[#15300c]">
            {result.proves.map((p) => (
              <li key={p}>• {p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-[#3d7a29]">
          Does NOT prove
        </h4>
        <ul className="space-y-1 text-[13px] leading-relaxed text-[#3a5230]">
          {result.doesNotProve.map((p) => (
            <li key={p}>• {p}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── open ───────────────────────────────────────────────────────────────────

function OpenPanel(props: {
  live: boolean;
  packageId: string;
  poolObjectId: string;
  coinType: string;
  amountDecimals: number;
}) {
  const [amount, setAmount] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [blinding, setBlinding] = useState("");
  const [commitment, setCommitment] = useState("");
  const [leafIndex, setLeafIndex] = useState("");
  const [txDigest, setTxDigest] = useState("");
  const [memo, setMemo] = useState("");
  const [label, setLabel] = useState("");
  const [ack, setAck] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("disclosure.json");
  const [error, setError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  /**
   * Fill leaf index + tx digest from the indexer. PUBLIC data only — this sends
   * a commitment (which is already on chain) and receives its coordinates. The
   * note secret is never sent anywhere.
   */
  async function lookupLocator() {
    setLookingUp(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/shield/disclose/locator?commitment=${encodeURIComponent(commitment.trim())}`,
        { cache: "no-store" }
      );
      const j = (await res.json()) as {
        item?: { leafIndex: number; txDigest: string | null };
        error?: string;
      };
      if (!res.ok || !j.item) throw new Error(j.error ?? `lookup failed (${res.status})`);
      setLeafIndex(String(j.item.leafIndex));
      setTxDigest(j.item.txDigest ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLookingUp(false);
    }
  }

  function build() {
    setError(null);
    setJson(null);
    try {
      const locator: NoteLocator = {
        coinType: props.coinType,
        packageId: props.packageId,
        poolObjectId: props.poolObjectId,
        leafIndex: Number(leafIndex),
        txDigest: txDigest.trim() || null,
      };
      const opening = buildNoteOpening({
        note: {
          amount: BigInt(amount.trim()),
          pubkey: BigInt(pubkey.trim()),
          blinding: BigInt(blinding.trim()),
          // The pool field is derived from the pool object id, so a mistyped
          // pool cannot silently produce a receipt for the wrong pool.
          pool: poolFieldFromAddress(props.poolObjectId),
        },
        locator,
        amountDecimals: props.amountDecimals,
        memo: memo.trim() || null,
      });
      if (commitment.trim() && opening.commitment !== commitment.trim()) {
        throw new Error(
          "the note you entered does not open the commitment you gave — check the amount, pubkey and blinding"
        );
      }
      const receipt = buildDisclosureReceipt({
        openings: [opening],
        disclosedBy: { label: label.trim() || null, suiAddress: null },
      });
      setJson(receiptToPrettyJson(receipt));
      setFilename(receiptFilename(receipt));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function download() {
    if (!json) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const ready = props.live && ack && amount && pubkey && blinding && leafIndex;

  return (
    <section className={CARD}>
      <h2 className="mb-1.5 text-[20px] font-[500] tracking-[-0.04em] text-[#15300c]" style={DISPLAY}>
        Open one of your notes
      </h2>
      <p className="mb-5 text-[14px] leading-relaxed text-[#3a5230]">
        Turn a shielded note you hold into a receipt you can hand over. The
        note&apos;s secret stays in this browser tab — it is written into the
        receipt file and sent nowhere else.
      </p>

      {!props.live ? (
        <p className="mb-5 rounded-2xl bg-white px-4 py-3 text-[13px] leading-relaxed text-[#3a5230]">
          Disclosure unlocks with private sends. Nothing to open yet.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="d-amount">
            Amount (base units, e.g. micros)
          </label>
          <input id="d-amount" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2500000" />
        </div>
        <div>
          <label className={LABEL} htmlFor="d-pubkey">
            Owner pubkey (decimal)
          </label>
          <input id="d-pubkey" className={INPUT} value={pubkey} onChange={(e) => setPubkey(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor="d-blinding">
            Blinding factor (decimal) — this is the secret being revealed
          </label>
          <input id="d-blinding" className={INPUT} value={blinding} onChange={(e) => setBlinding(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor="d-commitment">
            Commitment (optional — used to look up the leaf and to double-check you)
          </label>
          <div className="flex gap-2">
            <input id="d-commitment" className={INPUT} value={commitment} onChange={(e) => setCommitment(e.target.value)} />
            <button
              type="button"
              className={BTN_ALT}
              disabled={!props.live || lookingUp || !commitment.trim()}
              onClick={lookupLocator}
            >
              {lookingUp ? "…" : "Look up"}
            </button>
          </div>
        </div>
        <div>
          <label className={LABEL} htmlFor="d-leaf">
            Leaf index
          </label>
          <input id="d-leaf" className={INPUT} value={leafIndex} onChange={(e) => setLeafIndex(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="d-digest">
            Transaction digest
          </label>
          <input id="d-digest" className={INPUT} value={txDigest} onChange={(e) => setTxDigest(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="d-memo">
            Reference (optional)
          </label>
          <input id="d-memo" className={INPUT} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice 1234" />
        </div>
        <div>
          <label className={LABEL} htmlFor="d-label">
            Disclosed by (optional, unauthenticated)
          </label>
          <input id="d-label" className={INPUT} value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl bg-white p-4 text-[13px] leading-relaxed text-[#3a5230]">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[#15300c]"
        />
        <span>
          I understand this permanently deanonymises this one note to whoever
          receives the receipt, and that it cannot be revoked.
        </span>
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={!ready} onClick={build}>
          Build receipt
        </button>
        <button type="button" className={BTN_ALT} disabled={!json} onClick={download}>
          Download
        </button>
      </div>

      {error ? (
        <p className="mt-4 rounded-2xl bg-[#fff2ef] px-4 py-3 text-[13px] text-[#a12f1f]">{error}</p>
      ) : null}

      {json ? (
        <pre className="mt-5 max-h-80 overflow-auto rounded-2xl bg-white p-4 font-mono text-[11px] leading-relaxed text-[#15300c]">
          {json}
        </pre>
      ) : null}
    </section>
  );
}
