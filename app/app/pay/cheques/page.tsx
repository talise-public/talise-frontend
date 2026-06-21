"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Invoice01Icon,
  ArrowTurnBackwardIcon,
  Copy01Icon,
  Share08Icon,
  SecurityCheckIcon,
  GlobalIcon,
  CheckmarkBadge01Icon,
  Tick02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import {
  PrimaryButton,
  SlideToConfirm,
  Field,
  Spinner,
  EmptyState,
  StatusPill,
  AmountDisplay,
  QrImage,
  useToast,
  useMe,
  useSignAndSend,
  api,
  ApiError,
} from "@/components/app";
import type { StatusTone } from "@/components/app";
import { ChequeCard } from "@/components/app/cheques/ChequeCard";
import { PaySubNav } from "@/components/app/pay/PaySubNav";
import { signSponsorReadyBytes, friendlyError } from "@/components/app/cheques/signBytes";
import { Turnstile, turnstileEnabled } from "@/components/app/cheques/Turnstile";

// ── Types mirroring the live API responses ──────────────────────────────

type CreateResp = {
  chequeId: string;
  mode?: "onchain" | "escrow";
  fundingBytes?: string;
  escrowAddress?: string;
  amountUsd: number;
  claimUrl: string;
  secret: string;
  expiresAt: number;
  allowedCountries: string[];
};

type PreviewResp = {
  id: string;
  amountUsd: number;
  status: string;
  payeeLabel: string | null;
  memo: string | null;
  signatureName: string | null;
  creatorDisplay: string;
  allowedCountries: string[];
  expiresAt: number;
  claimable: boolean;
};

type ClaimResp = { ok: boolean; digest?: string; amountUsd?: number };

type ReclaimResp = {
  ok?: boolean;
  mode?: "onchain" | "escrow";
  reclaimBytes?: string;
  status?: string;
  digest?: string;
  amountUsd?: number;
};

type MyChequeRow = {
  id: string;
  amountUsd: number;
  status: string;
  memo: string | null;
  payeeLabel: string | null;
  createdAt: number;
  expiresAt: number;
  reclaimable: boolean;
};

type Tab = "write" | "cash" | "mine";

// ── Page shell + tabs ────────────────────────────────────────────────────

export default function ChequesPage() {
  const [tab, setTab] = useState<Tab>("write");
  // Bumped after a successful action to force the MINE list to re-pull.
  const [mineReload, setMineReload] = useState(0);

  const tabs: { id: Tab; label: string }[] = [
    { id: "write", label: "Write" },
    { id: "cash", label: "Cash" },
    { id: "mine", label: "Mine" },
  ];

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      {/* Keep the Pay sub-nav visible on this sibling route too — without it
          mobile users who tapped into Cheques lost the way back to
          Send/Request/Stream. */}
      <PaySubNav />
      <header className="space-y-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Cheques
        </span>
        <h1
          className="text-[clamp(26px,5vw,34px)] font-[800] uppercase leading-[1.02] tracking-[-0.02em] text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Money in a link
        </h1>
        <p className="text-[14px] leading-[1.5] text-[#3a5230]">
          {/* Short on phones; the fuller line reads on wider screens. */}
          <span className="sm:hidden">A link anyone can claim as real money.</span>
          <span className="hidden sm:inline">
            Write a cheque, drop the link in any DM, and they claim it as real
            money. No account, no app required.
          </span>
        </p>
      </header>

      {/* Segmented control */}
      <div
        className="flex w-full gap-1 rounded-full border border-[#15300c]/15 bg-white/60 p-1 backdrop-blur-sm"
        role="tablist"
      >
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-full px-4 py-2 text-[14px] transition-colors ${
                active
                  ? "bg-[#CAFFB8] font-semibold text-[#15300c]"
                  : "text-[#3a5230] hover:text-[#15300c]"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "write" && <WriteTab onIssued={() => setMineReload((n) => n + 1)} />}
      {tab === "cash" && <CashTab />}
      {tab === "mine" && (
        <MineTab
          reloadSignal={mineReload}
          onReclaimed={() => setMineReload((n) => n + 1)}
          onWrite={() => setTab("write")}
        />
      )}
    </div>
  );
}

// ── WRITE ────────────────────────────────────────────────────────────────

function WriteTab({ onIssued }: { onIssued: () => void }) {
  const { me } = useMe();
  const { send } = useSignAndSend();
  const { toast } = useToast();

  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [gateCountry, setGateCountry] = useState(false);
  const [country, setCountry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<CreateResp | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const amountUsd = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const signature = me?.name || me?.taliseHandle || "Talise";
  const canIssue = amountUsd >= 0.01 && payee.trim().length > 0;

  const issue = useCallback(async () => {
    if (!canIssue) return;
    setError(null);
    try {
      const created = await api<CreateResp>("/api/cheques/create", {
        method: "POST",
        body: {
          amountUsd,
          payeeLabel: payee.trim(),
          memo: memo.trim() || undefined,
          allowedCountries:
            gateCountry && country.trim() ? [country.trim().toUpperCase()] : [],
        },
      });

      // Fund the cheque, two rails picked by `mode`:
      //   • "onchain" → sign the sponsor-ready cheque::create bytes
      //   • "escrow"/absent → fund the escrow address over the normal send rail
      let fundingDigest: string;
      if (created.mode === "onchain" && created.fundingBytes) {
        const { digest } = await signSponsorReadyBytes(created.fundingBytes, {
          intent: "fund-cheque",
        });
        fundingDigest = digest;
      } else if (created.escrowAddress) {
        const { digest } = await send({
          to: created.escrowAddress,
          amountUsd,
        });
        fundingDigest = digest;
      } else {
        throw new ApiError(500, "Couldn't issue the cheque right now.", null);
      }

      // Flip draft → funded with the funding digest.
      await api(`/api/cheques/${created.chequeId}/confirm-funded`, {
        method: "POST",
        body: { digest: fundingDigest },
      });

      setIssued(created);
      onIssued();
    } catch (e) {
      const msg = friendlyError(e, "Couldn't issue the cheque right now.", "Cheques");
      setError(msg);
      setResetSignal((n) => n + 1);
      throw e; // let SlideToConfirm spring back
    }
  }, [amountUsd, payee, memo, gateCountry, country, canIssue, send, onIssued]);

  if (issued) {
    return (
      <IssuedView
        resp={issued}
        payee={payee.trim()}
        memo={memo.trim()}
        signature={signature}
        onReclaimed={onIssued}
        onDone={() => {
          // Reset the form for the next cheque.
          setIssued(null);
          setAmount("");
          setPayee("");
          setMemo("");
          setGateCountry(false);
          setCountry("");
          setResetSignal((n) => n + 1);
        }}
        copyToast={(m) => toast(m, "success")}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Live cheque preview */}
      <ChequeCard
        amountUsd={amountUsd}
        payee={payee.trim()}
        memo={memo.trim()}
        signature={signature}
        chequeNo="•••••"
      />

      {/* Form fields */}
      <div
        className="divide-y divide-[#15300c]/10 overflow-hidden rounded-[28px] bg-[#f7fcf2]"
        style={{ boxShadow: "10px 10px 0 #15300c" }}
      >
        {/* Amount */}
        <div className="px-5 py-4">
          <label className="block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
            Amount (USDsui)
          </label>
          <div className="mt-2 flex items-center gap-1.5">
            <span
              className="text-[22px] text-[#3a5230]"
              style={{ fontFamily: "var(--font-display-v2)" }}
            >
              $
            </span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.00"
              className="w-full bg-transparent text-[28px] font-[800] tracking-[-0.02em] text-[#15300c] tabular-nums outline-none placeholder:text-[#3d7a29]/60"
              style={{ fontFamily: "var(--font-display-v2)" }}
            />
          </div>
        </div>

        {/* Pay to */}
        <div className="px-5 py-4">
          <label className="block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
            Pay to
          </label>
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            maxLength={80}
            placeholder="Name on the cheque"
            className="mt-2 w-full bg-transparent text-[15px] text-[#15300c] outline-none placeholder:text-[#3d7a29]/60"
          />
        </div>

        {/* Memo */}
        <div className="px-5 py-4">
          <label className="block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
            Memo (optional)
          </label>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={140}
            placeholder="What's it for?"
            className="mt-2 w-full bg-transparent text-[15px] text-[#15300c] outline-none placeholder:text-[#3d7a29]/60"
          />
        </div>

        {/* Country restriction toggle */}
        <div className="px-5 py-4">
          <button
            type="button"
            onClick={() => setGateCountry((v) => !v)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="flex flex-col">
              <span className="text-[14px] font-medium text-[#15300c]">Restrict by country</span>
              <span className="font-mono text-[10px] text-[#3d7a29]">
                Only claimable from one country (IP-checked)
              </span>
            </span>
            <span
              className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
              style={{
                background: gateCountry ? "#3d7a29" : "rgba(21,48,12,0.12)",
              }}
            >
              <span
                className="absolute top-0.5 size-5 rounded-full bg-white transition-transform"
                style={{ transform: gateCountry ? "translateX(22px)" : "translateX(2px)" }}
              />
            </span>
          </button>

          {gateCountry && (
            <div className="mt-3">
              <Field label="Country (ISO code)" hint="Two-letter code, e.g. NG, US, GB.">
                <input
                  value={country}
                  onChange={(e) =>
                    setCountry(e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2))
                  }
                  placeholder="NG"
                  className="w-full border-b border-[#15300c]/15 bg-transparent pb-2 font-mono text-[15px] uppercase text-[#15300c] outline-none placeholder:text-[#3d7a29]/60"
                />
              </Field>
            </div>
          )}
        </div>

        {/* Security notice */}
        <div className="flex items-center gap-2 px-5 py-3">
          <HugeiconsIcon icon={SecurityCheckIcon} size={13} className="text-[#3d7a29]" />
          <span className="font-mono text-[10px] text-[#3d7a29]">
            Always protected: captcha + no-VPN on claim
          </span>
        </div>
      </div>

      {error && <InlineError>{error}</InlineError>}

      <SlideToConfirm
        label="Slide to sign & fund"
        onConfirm={issue}
        disabled={!canIssue}
        resetSignal={resetSignal}
      />
    </div>
  );
}

// ── Issued (share + reclaim) ──────────────────────────────────────────────

function IssuedView({
  resp,
  payee,
  memo,
  signature,
  onDone,
  onReclaimed,
  copyToast,
}: {
  resp: CreateResp;
  payee: string;
  memo: string;
  signature: string;
  onDone: () => void;
  onReclaimed: () => void;
  copyToast: (m: string) => void;
}) {
  const [reclaimed, setReclaimed] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(resp.claimUrl);
      setCopied(true);
      copyToast("Cheque link copied");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      copyToast("Couldn't copy, long-press the link to copy it.");
    }
  }, [resp.claimUrl, copyToast]);

  const share = useCallback(async () => {
    const data = {
      title: "A Talise cheque for you",
      text: `I sent you ${resp.amountUsd.toFixed(2)} USDsui. Claim it:`,
      url: resp.claimUrl,
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch {
        /* user cancelled — fall through to copy */
      }
    }
    void copy();
  }, [resp, copy]);

  const reclaim = useCallback(async () => {
    setReclaiming(true);
    setError(null);
    try {
      const built = await api<ReclaimResp>(`/api/cheques/${resp.chequeId}/reclaim`, {
        method: "POST",
        body: {},
      });
      if (built.mode === "onchain" && built.reclaimBytes) {
        const { digest } = await signSponsorReadyBytes(built.reclaimBytes, {
          intent: "reclaim-cheque",
        });
        await api(`/api/cheques/${resp.chequeId}/reclaim`, {
          method: "POST",
          body: { digest },
        });
      }
      setReclaimed(true);
      onReclaimed();
    } catch (e) {
      setError(reclaimError(e));
    } finally {
      setReclaiming(false);
    }
  }, [resp.chequeId, onReclaimed]);

  return (
    <div className="space-y-6 text-center">
      <h2
        className="text-[22px] font-[800] uppercase tracking-[-0.02em] text-[#15300c]"
        style={{ fontFamily: "var(--font-display-v2)" }}
      >
        {reclaimed ? "Cheque reclaimed" : "Cheque issued"}
      </h2>

      <ChequeCard
        amountUsd={resp.amountUsd}
        payee={payee || "—"}
        memo={memo}
        signature={signature}
        chequeNo={resp.chequeId.slice(-5)}
        stamp={reclaimed ? "RECLAIMED" : "ISSUED"}
      />

      <p className="mx-auto max-w-sm text-[14px] text-[#3a5230]">
        {reclaimed
          ? "The money is back in your Talise balance."
          : "Send this link in any DM. They claim it as money."}
      </p>

      {!reclaimed && (
        <>
          <div className="flex justify-center">
            <QrImage value={resp.claimUrl} size={180} />
          </div>

          {/* Copyable link row */}
          <button
            type="button"
            onClick={copy}
            className="mx-auto flex w-full max-w-md items-center gap-2 rounded-2xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-left backdrop-blur-sm transition-colors hover:border-[#15300c]/30"
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={16}
              className={copied ? "text-[#3d7a29]" : "text-[#3a5230]"}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#3a5230]">
              {resp.claimUrl}
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.28em] text-[#3d7a29]">
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        </>
      )}

      {error && <InlineError>{error}</InlineError>}

      <div className="mx-auto flex w-full max-w-md flex-col gap-3">
        {reclaimed ? (
          <PrimaryButton onClick={onDone} full>
            Write another
          </PrimaryButton>
        ) : (
          <>
            <PrimaryButton onClick={share} full>
              <HugeiconsIcon icon={Share08Icon} size={18} />
              Share cheque link
            </PrimaryButton>
            <PrimaryButton variant="ghost" onClick={reclaim} loading={reclaiming} full>
              {!reclaiming && <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={16} />}
              {reclaiming ? "Claiming back…" : "Claim it back"}
            </PrimaryButton>
            <button
              type="button"
              onClick={onDone}
              disabled={reclaiming}
              className="py-2 text-[14px] text-[#3d7a29] transition-colors hover:text-[#15300c] disabled:opacity-50"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── CASH ───────────────────────────────────────────────────────────────────

function CashTab() {
  const [link, setLink] = useState("");
  const [parsed, setParsed] = useState<{ id: string; secret: string } | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cashed, setCashed] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  // Parse `…/c/<id>?s=<secret>` or `…/c/<id>#<secret>` (both shapes supported).
  function parse(s: string): { id: string; secret: string } | null {
    const trimmed = s.trim();
    if (!trimmed) return null;
    let id = "";
    let secret = "";
    try {
      const u = new URL(trimmed);
      const m = u.pathname.match(/\/c\/([^/]+)/);
      if (m) id = decodeURIComponent(m[1]);
      secret = u.searchParams.get("s") ?? u.hash.replace(/^#/, "");
    } catch {
      // Not a full URL — try the hash form directly.
      const hashIdx = trimmed.indexOf("#");
      const queryIdx = trimmed.indexOf("?s=");
      const slash = trimmed.lastIndexOf("/c/");
      if (slash === -1) return null;
      const after = trimmed.slice(slash + 3);
      if (hashIdx !== -1) {
        secret = trimmed.slice(hashIdx + 1);
        id = after.split("#")[0].split("?")[0];
      } else if (queryIdx !== -1) {
        secret = trimmed.slice(queryIdx + 3);
        id = after.split("?")[0];
      }
    }
    secret = decodeURIComponent(secret || "");
    if (!id || !secret) return null;
    return { id, secret };
  }

  const open = useCallback(async () => {
    const p = parse(link);
    if (!p) {
      setError("That doesn't look like a cheque link.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const pv = await api<PreviewResp>(`/api/cheques/${p.id}/preview`, {
        query: { s: p.secret },
      });
      setParsed(p);
      setPreview(pv);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 503 || /disabled|not configured/i.test(e.message))) {
        setError("Cheques are rolling out, check back soon.");
      } else {
        setError("Couldn't open this cheque, it may be invalid or already claimed.");
      }
    } finally {
      setLoading(false);
    }
  }, [link]);

  const claim = useCallback(async () => {
    if (!parsed) return;
    if (turnstileEnabled() && !token) {
      setError("Complete the human check below, then slide to cash.");
      throw new ApiError(0, "captcha-required", null);
    }
    setClaiming(true);
    setError(null);
    try {
      const r = await api<ClaimResp>(`/api/cheques/${parsed.id}/claim/release`, {
        method: "POST",
        body: { secret: parsed.secret, turnstileToken: token },
      });
      if (r.ok) {
        setCashed(r.amountUsd ?? preview?.amountUsd ?? 0);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("talise:tx", { detail: { kind: "cheque-claim" } }));
        }
      }
    } catch (e) {
      setError(gateError(e));
      setToken(null);
      setResetSignal((n) => n + 1);
      throw e;
    } finally {
      setClaiming(false);
    }
  }, [parsed, token, preview]);

  if (cashed != null) {
    return (
      <div className="flex flex-col items-center gap-5 py-10 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-[#CAFFB8]">
          <HugeiconsIcon icon={CheckmarkBadge01Icon} size={32} className="text-[#15300c]" />
        </span>
        <div>
          <AmountDisplay usd={cashed} size={34} />
          <p className="mt-2 text-[14px] text-[#3a5230]">It&apos;s in your Talise balance.</p>
        </div>
        <PrimaryButton
          onClick={() => {
            setCashed(null);
            setPreview(null);
            setParsed(null);
            setLink("");
            setToken(null);
          }}
        >
          Cash another
        </PrimaryButton>
      </div>
    );
  }

  if (preview && parsed) {
    return (
      <div className="space-y-5 text-center">
        <p className="text-[13px] text-[#3a5230]">From {preview.creatorDisplay}</p>
        <ChequeCard
          amountUsd={preview.amountUsd}
          payee={preview.payeeLabel ?? "You"}
          memo={preview.memo ?? ""}
          signature={preview.signatureName ?? ""}
          chequeNo={preview.id.slice(-5)}
          stamp={preview.claimable ? undefined : preview.status.toUpperCase()}
        />

        {preview.allowedCountries.length > 0 && (
          <div className="flex items-center justify-center gap-1.5 font-mono text-[11px] text-[#3d7a29]">
            <HugeiconsIcon icon={GlobalIcon} size={13} />
            Claimable only from {preview.allowedCountries.join(", ")}
          </div>
        )}

        {preview.claimable ? (
          <>
            {turnstileEnabled() && (
              <div className="flex justify-center">
                <Turnstile onToken={setToken} />
              </div>
            )}
            {error && <InlineError>{error}</InlineError>}
            <SlideToConfirm
              label={claiming ? "Cashing…" : "Slide to cash this cheque"}
              onConfirm={claim}
              tint="#3d7a29"
              disabled={claiming}
              resetSignal={resetSignal}
            />
          </>
        ) : (
          <div className="space-y-4">
            <p className="text-[14px] text-[#3a5230]">This cheque is {preview.status}.</p>
            <PrimaryButton
              variant="ghost"
              onClick={() => {
                setPreview(null);
                setParsed(null);
                setLink("");
              }}
            >
              Try another link
            </PrimaryButton>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="space-y-4 rounded-[28px] bg-[#f7fcf2] p-5"
        style={{ boxShadow: "10px 10px 0 #15300c" }}
      >
        <div>
          <label className="block font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[#3d7a29]">
            Paste a cheque link
          </label>
          <p className="mt-0.5 font-mono text-[10px] text-[#3d7a29]">Looks like talise.io/c/…</p>
          <textarea
            value={link}
            onChange={(e) => setLink(e.target.value)}
            rows={2}
            placeholder="https://talise.io/c/…"
            className="mt-3 w-full resize-none rounded-2xl border border-[#15300c]/15 bg-white/60 p-3.5 font-mono text-[13px] text-[#15300c] outline-none backdrop-blur-sm transition-colors placeholder:text-[#3d7a29]/60 focus:border-[#15300c]/30"
          />
        </div>
        <PrimaryButton onClick={open} loading={loading} disabled={!link.trim()} full>
          {loading ? "Loading…" : "Open cheque"}
        </PrimaryButton>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}

// ── MINE ─────────────────────────────────────────────────────────────────

function MineTab({
  reloadSignal,
  onReclaimed,
  onWrite,
}: {
  reloadSignal: number;
  onReclaimed: () => void;
  onWrite: () => void;
}) {
  const [rows, setRows] = useState<MyChequeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reclaiming, setReclaiming] = useState<Set<string>>(new Set());

  // Stale-while-revalidate: paint the last-known list from sessionStorage
  // INSTANTLY (no skeleton on revisit), then refresh quietly. The list is
  // display-only here — every mutating action re-validates server-side.
  const CACHE_KEY = "talise:cheques:mine";

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    try {
      const r = await api<{ cheques: MyChequeRow[] }>("/api/cheques/mine");
      const next = r.cheques ?? [];
      setRows(next);
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked — non-fatal */
      }
    } catch (e) {
      if (!background) {
        setError(friendlyError(e, "Couldn't load your cheques right now.", "Cheques"));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Seed from the session cache, then revalidate in the background.
    let seeded = false;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        setRows(JSON.parse(raw) as MyChequeRow[]);
        setLoading(false);
        seeded = true;
      }
    } catch {
      /* corrupt cache — fall through to a foreground load */
    }
    void load(seeded);
  }, [load, reloadSignal]);

  const reclaim = useCallback(
    async (row: MyChequeRow) => {
      setReclaiming((s) => new Set(s).add(row.id));
      setError(null);
      try {
        const built = await api<ReclaimResp>(`/api/cheques/${row.id}/reclaim`, {
          method: "POST",
          body: {},
        });
        if (built.mode === "onchain" && built.reclaimBytes) {
          const { digest } = await signSponsorReadyBytes(built.reclaimBytes, {
            intent: "reclaim-cheque",
          });
          await api(`/api/cheques/${row.id}/reclaim`, {
            method: "POST",
            body: { digest },
          });
        }
        onReclaimed();
        await load();
      } catch (e) {
        setError(reclaimError(e));
      } finally {
        setReclaiming((s) => {
          const next = new Set(s);
          next.delete(row.id);
          return next;
        });
      }
    },
    [load, onReclaimed]
  );

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={26} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <p className="max-w-xs text-[14px] text-[#3a5230]">{error}</p>
        <PrimaryButton variant="ghost" onClick={load}>
          Try again
        </PrimaryButton>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<HugeiconsIcon icon={Invoice01Icon} size={26} />}
        title="No cheques yet"
        subtitle="Cheques you write show up here so you can track and reclaim them."
        action={
          <PrimaryButton onClick={onWrite}>Write a cheque</PrimaryButton>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div
          key={row.id}
          className="rounded-[28px] bg-[#f7fcf2] p-5"
          style={{ boxShadow: "10px 10px 0 #15300c" }}
        >
          {/* Amount + status header */}
          <div className="flex items-start justify-between gap-3">
            <AmountDisplay usd={row.amountUsd} size={22} subAsset />
            <StatusPill label={row.status} tone={statusTone(row.status)} />
          </div>

          {/* Memo / payee sublabel */}
          {subtitleFor(row) && (
            <p className="mt-2 text-[13px] text-[#3a5230]">{subtitleFor(row)}</p>
          )}

          {/* Date */}
          <p className="mt-1 font-mono text-[10px] text-[#3d7a29]">{dateText(row.createdAt)}</p>

          {/* Reclaim action */}
          {row.reclaimable && (
            <div className="mt-4">
              <PrimaryButton
                variant="ghost"
                full
                loading={reclaiming.has(row.id)}
                onClick={() => reclaim(row)}
              >
                {!reclaiming.has(row.id) && (
                  <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={15} />
                )}
                {reclaiming.has(row.id) ? "Claiming back…" : "Claim it back"}
              </PrimaryButton>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-[#15300c]/10 bg-[#FF9E7A]/25 px-4 py-3 text-[13px] text-[#7a2e15]">
      <HugeiconsIcon icon={Cancel01Icon} size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case "funded":
      return "funded";
    case "claimed":
      return "claimed";
    case "draft":
      return "pending";
    default:
      return "neutral"; // reclaimed / voided / expired
  }
}

function subtitleFor(row: MyChequeRow): string {
  if (row.memo) return row.memo;
  if (row.payeeLabel) return `To ${row.payeeLabel}`;
  return "";
}

function dateText(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/** Friendly copy for a reclaim ("claim it back") failure. */
function reclaimError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "NOT_SIGNED_IN" || e.status === 401) {
      return "Your session expired, refresh and sign in to reclaim.";
    }
    if (e.status === 409) {
      // Server returns { error: "not_reclaimable", status } once it's been
      // claimed/voided/reclaimed already.
      return "This cheque can no longer be reclaimed, it may already be claimed or reclaimed.";
    }
  }
  return friendlyError(e, "Couldn't claim this cheque back right now.", "Cheques");
}

/** Map a claim/release error into friendly copy (incl. GATE_FAILED reasons). */
function gateError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "NOT_SIGNED_IN" || e.status === 401) {
      return "Your session expired, refresh and sign in to cash this cheque.";
    }
    if (e.code === "GATE_FAILED" || e.status === 403) {
      // The server already returns reason-specific copy in `message`.
      return e.message || "Claim blocked, turn off any VPN and try again.";
    }
    if (e.status === 409) {
      return "This cheque has already been claimed or expired.";
    }
    if (e.message === "captcha-required") return "Complete the human check, then slide to cash.";
    if (e.message) return e.message;
  }
  return "Couldn't cash this cheque right now.";
}
