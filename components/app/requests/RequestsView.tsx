"use client";

/**
 * RequestsView — tracked money requests (/app/requests).
 *
 * The INVERSE of a cheque: "I need $X from you, here's a link to pay me." Unlike
 * the receive-QR on /app/pay/request (which mints an ephemeral /pay/<handle>
 * link with no tracking), each request here is a real row that flips to PAID
 * once it's settled on-chain — so you can see who has paid and cancel the rest.
 *
 *   • Create  → POST /api/requests { amountUsd, note? } → { request, payUrl }.
 *               The result view shows the public /req/<id> link + a QR + share.
 *   • List    → GET /api/requests, newest first, with a status pill.
 *   • Cancel  → DELETE /api/requests/{id} for an open request.
 *
 * Matches the v2 app look (GlassCard rows, StatusPill, Sheet) and reuses the
 * shared primitives + the same-origin `api` client (cookie-authed).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { publicOrigin } from "@/lib/public-origin";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  PlusSignIcon,
  Copy01Icon,
  Tick02Icon,
  Share08Icon,
  Cancel01Icon,
  MoneyReceive01Icon,
  QrCode01Icon,
  ArrowRight02Icon,
} from "@hugeicons/core-free-icons";
import {
  GlassCard,
  PrimaryButton,
  StatusPill,
  Sheet,
  Field,
  Eyebrow,
  EmptyState,
  Spinner,
  QrImage,
  api,
  ApiError,
  useToast,
  useCurrency,
  type StatusTone,
} from "@/components/app";

type ReqStatus = "open" | "paid" | "cancelled" | "expired";

type MoneyRequest = {
  id: string;
  amountUsd: number;
  currency: string;
  requesterNote: string | null;
  status: ReqStatus;
  createdAt: number;
  expiresAt: number | null;
  paidAt: number | null;
};

const ORIGIN = publicOrigin();

/** Public pay link for a request slug. */
function reqUrl(id: string): string {
  return `${ORIGIN}/req/${id}`;
}

function statusMeta(s: ReqStatus): { label: string; tone: StatusTone } {
  switch (s) {
    case "paid":
      return { label: "Paid", tone: "completed" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "expired":
      return { label: "Expired", tone: "danger" };
    default:
      return { label: "Open", tone: "pending" };
  }
}

export function RequestsView() {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const [requests, setRequests] = useState<MoneyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  // A request whose share card (link + QR) is open, and the one targeted by the
  // cancel confirmation sheet.
  const [shareFor, setShareFor] = useState<MoneyRequest | null>(null);
  const [cancelFor, setCancelFor] = useState<MoneyRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ requests: MoneyRequest[] }>("/api/requests");
      setRequests(r.requests ?? []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Requests
        </div>
        <h1
          className="mt-2 text-[clamp(24px,4vw,34px)] font-[800] uppercase tracking-[-0.02em] text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Ask to get paid.
        </h1>
        <p className="mt-2 max-w-xl text-[14px] leading-[1.5] text-[#3a5230]">
          Send someone a link to pay you a set amount. It clears the moment they
          pay — gasless, no wallet needed — and you can see who&apos;s settled.
        </p>
      </header>

      <div className="flex items-center justify-between">
        <Eyebrow>Your requests</Eyebrow>
        <PrimaryButton onClick={() => setCreateOpen(true)} variant="ghost">
          <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
          New request
        </PrimaryButton>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={22} />
        </div>
      ) : requests.length === 0 ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={<HugeiconsIcon icon={MoneyReceive01Icon} size={26} strokeWidth={1.6} />}
            title="No requests yet"
            subtitle="Create a request and share a pay link that anyone can settle in a tap."
            action={
              <PrimaryButton onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
                New request
              </PrimaryButton>
            }
          />
        </GlassCard>
      ) : (
        <GlassCard className="overflow-hidden p-0">
          {requests.map((req, i) => (
            <RequestRow
              key={req.id}
              req={req}
              formatUsd={formatUsd}
              onShare={() => setShareFor(req)}
              onCancel={() => setCancelFor(req)}
              divider={i < requests.length - 1}
            />
          ))}
        </GlassCard>
      )}

      <CreateRequestSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          setShareFor(created);
          void load();
        }}
      />

      <ShareSheet request={shareFor} onClose={() => setShareFor(null)} />

      <CancelSheet
        request={cancelFor}
        onClose={() => setCancelFor(null)}
        onDone={() => {
          setCancelFor(null);
          void load();
        }}
      />
    </div>
  );
}

// ── Request row ────────────────────────────────────────────────────────────

function RequestRow({
  req,
  formatUsd,
  onShare,
  onCancel,
  divider,
}: {
  req: MoneyRequest;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  onShare: () => void;
  onCancel: () => void;
  divider: boolean;
}) {
  const { label, tone } = statusMeta(req.status);
  const created = new Date(req.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const title = req.requesterNote?.trim() || "Money request";

  return (
    <div>
      <button
        type="button"
        onClick={onShare}
        className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-[#15300c]/[0.04]"
        aria-label={`Share request ${title}`}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={MoneyReceive01Icon} size={17} strokeWidth={1.8} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-[#15300c]">{title}</span>
          <span className="block truncate font-mono text-[11px] text-[#3d7a29]">
            {req.id.replace(/^req_/, "").slice(0, 8)}… · {created}
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className="text-[15px] font-semibold text-[#15300c]"
            style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}
          >
            {formatUsd(req.amountUsd, { fixed: true })}
          </span>
          <StatusPill label={label} tone={tone} />
        </span>

        <HugeiconsIcon
          icon={ArrowRight02Icon}
          size={15}
          strokeWidth={2}
          className="shrink-0 text-[#3d7a29]"
        />
      </button>

      <div className="flex items-center gap-1 px-4 pb-3 pt-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShare();
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 text-[12px] text-[#3a5230] backdrop-blur-sm transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c]"
        >
          <HugeiconsIcon icon={QrCode01Icon} size={12} strokeWidth={2} />
          Link &amp; QR
        </button>
        {req.status === "open" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-[#3d7a29] transition-colors hover:text-[#c0532f]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            Cancel
          </button>
        )}
      </div>

      {divider && <div className="mx-4 border-t border-[#15300c]/10" />}
    </div>
  );
}

// ── Create sheet ───────────────────────────────────────────────────────────

function CreateRequestSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: MoneyRequest) => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount("");
      setNote("");
    }
  }, [open]);

  const amountUsd = useMemo(() => {
    const v = parseFloat(amount);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [amount]);

  const submit = async () => {
    if (amountUsd == null) {
      toast("Enter an amount greater than zero", "danger");
      return;
    }
    setSubmitting(true);
    try {
      const r = await api<{ ok: boolean; request: MoneyRequest; payUrl: string }>(
        "/api/requests",
        {
          method: "POST",
          body: { amountUsd, note: note.trim() || undefined },
        }
      );
      try {
        await navigator.clipboard.writeText(r.payUrl);
        toast("Request created — pay link copied", "success");
      } catch {
        toast("Request created", "success");
      }
      onCreated(r.request);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't create request", "danger");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New request">
      <div className="space-y-4">
        <Field label="Amount" hint="What you're asking for, in USD (settles 1:1 as USDsui)">
          <div className="flex items-center gap-1.5 rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 backdrop-blur-sm focus-within:ring-2 focus-within:ring-[#3d7a29]/45">
            <span className="text-[20px] text-[#3a5230]" style={{ fontFamily: "var(--font-display-v2)" }}>
              $
            </span>
            <input
              value={amount}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
              }}
              inputMode="decimal"
              placeholder="0.00"
              autoFocus
              className="w-full bg-transparent text-[22px] font-[700] text-[#15300c] tabular-nums outline-none placeholder:text-[#3d7a29]"
              style={{ letterSpacing: "-0.02em" }}
            />
          </div>
        </Field>

        <Field label="Note" hint="What's it for? (optional, shown on the request)">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 280))}
            placeholder="Dinner last night"
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
          />
        </Field>

        <PrimaryButton onClick={submit} disabled={amountUsd == null || submitting} loading={submitting} full>
          Create request &amp; copy link
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

// ── Share sheet (link + QR) ──────────────────────────────────────────────────

function ShareSheet({ request, onClose }: { request: MoneyRequest | null; onClose: () => void }) {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (request) setCopied(false);
  }, [request]);

  const url = request ? reqUrl(request.id) : "";

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast("Pay link copied", "success");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("Couldn't copy link", "danger");
    }
  };

  const share = async () => {
    if (!url) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: "Pay me on Talise",
          text: request ? `Pay ${formatUsd(request.amountUsd, { fixed: true })} on Talise` : "Pay me on Talise",
          url,
        });
        return;
      } catch {
        /* cancelled / unsupported — fall through to copy */
      }
    }
    await copy();
  };

  return (
    <Sheet open={!!request} onClose={onClose} title="Share request">
      {request && (
        <div className="space-y-5">
          <div className="flex flex-col items-center text-center">
            <span
              className="text-[28px] font-[800] tabular-nums text-[#15300c]"
              style={{ fontFamily: "var(--font-display-v2)", letterSpacing: "-0.02em" }}
            >
              {formatUsd(request.amountUsd, { fixed: true })}
            </span>
            {request.requesterNote?.trim() && (
              <span className="mt-1 max-w-[18rem] truncate text-[13px] text-[#3d7a29]">
                &ldquo;{request.requesterNote.trim()}&rdquo;
              </span>
            )}
            <div className="mt-4">
              <QrImage value={url} size={196} />
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 backdrop-blur-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#3a5230]">{url}</span>
          </div>

          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={copy}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border-2 border-[#15300c] px-5 py-3 text-[14px] font-medium text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                size={16}
                strokeWidth={2}
                color={copied ? "#3d7a29" : undefined}
              />
              {copied ? "Copied" : "Copy link"}
            </button>
            <div className="flex-1">
              <PrimaryButton full onClick={share}>
                <HugeiconsIcon icon={Share08Icon} size={15} strokeWidth={2} color="#f7fcf2" />
                Share
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ── Cancel sheet ───────────────────────────────────────────────────────────

function CancelSheet({
  request,
  onClose,
  onDone,
}: {
  request: MoneyRequest | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!request) return;
    setSubmitting(true);
    try {
      await api(`/api/requests/${request.id}`, { method: "DELETE" });
      toast("Request cancelled", "neutral");
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't cancel request", "danger");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={!!request} onClose={onClose} title="Cancel request">
      <div className="space-y-4">
        <p className="text-[14px] text-[#3a5230]">
          Cancelling stops this request&apos;s pay link from working. This can&apos;t be undone.
        </p>
        <div className="flex items-center gap-2">
          <PrimaryButton onClick={onClose} variant="ghost" full>
            Keep it
          </PrimaryButton>
          <PrimaryButton onClick={submit} variant="danger" loading={submitting} full>
            Cancel request
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}

export default RequestsView;
