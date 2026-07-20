"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { publicOrigin } from "@/lib/public-origin";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  Invoice01Icon,
  Copy01Icon,
  Cancel01Icon,
  PlusSignIcon,
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
  api,
  ApiError,
  useToast,
  useCurrency,
} from "@/components/app";

type LineItem = { description: string; qty: string; unitUsd: string };

type Invoice = {
  id: string;
  amountUsd: number;
  currency: string;
  customerName: string | null;
  customerEmail: string | null;
  lineItems: { description: string; qty: number; unitUsd: number }[];
  memo: string | null;
  status: "open" | "paid" | "void";
  dueMs: number | null;
  createdAt: number;
};

const ORIGIN = publicOrigin();

export function InvoicesTab() {
  const router = useRouter();
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  // The invoice currently targeted by the void confirmation sheet. (There is
  // no manual mark-paid, settlement is detected automatically: the public
  // pay page settles trustlessly, and /api/invoices runs an on-chain-verified
  // auto-settle sweep for direct payments.)
  const [voidFor, setVoidFor] = useState<Invoice | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ invoices: Invoice[] }>("/api/invoices");
      setInvoices(r.invoices ?? []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copyLink = async (id: string) => {
    try {
      await navigator.clipboard.writeText(`${ORIGIN}/i/${id}`);
      toast("Pay link copied", "success");
    } catch {
      toast("Couldn't copy link", "danger");
    }
  };

  const open = (id: string) => router.push(`/app/work/invoices/${id}`);

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <Eyebrow>Your invoices</Eyebrow>
        <PrimaryButton onClick={() => setCreateOpen(true)} variant="ghost">
          <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
          New invoice
        </PrimaryButton>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={22} />
        </div>
      ) : invoices.length === 0 ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={<HugeiconsIcon icon={Invoice01Icon} size={26} strokeWidth={1.6} />}
            title="No invoices yet"
            subtitle="Create your first invoice and share a pay link that works for anyone, gasless, no wallet needed."
            action={
              <PrimaryButton onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
                Create invoice
              </PrimaryButton>
            }
          />
        </GlassCard>
      ) : (
        /* Wise-style: all invoices in one flat card as stacked rows */
        <GlassCard className="overflow-hidden p-0">
          {invoices.map((inv, i) => (
            <InvoiceRow
              key={inv.id}
              inv={inv}
              formatUsd={formatUsd}
              onOpen={() => open(inv.id)}
              onCopy={() => copyLink(inv.id)}
              onVoid={() => setVoidFor(inv)}
              divider={i < invoices.length - 1}
            />
          ))}
        </GlassCard>
      )}

      <CreateInvoiceSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void load();
        }}
      />

      <VoidSheet
        invoice={voidFor}
        onClose={() => setVoidFor(null)}
        onDone={() => {
          setVoidFor(null);
          void load();
        }}
      />
    </div>
  );
}

// ── Void sheet (replaces window.confirm) ───────────────────────────────────

function VoidSheet({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!invoice) return;
    setSubmitting(true);
    try {
      await api(`/api/invoices/${invoice.id}`, {
        method: "POST",
        body: { action: "void" },
      });
      toast("Invoice voided", "neutral");
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't void invoice", "danger");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={!!invoice} onClose={onClose} title="Void invoice">
      <div className="space-y-4">
        <p className="text-[14px] text-[#3a5230]">
          Voiding this invoice stops its pay link from working. This can&apos;t be undone.
        </p>
        <div className="flex items-center gap-2">
          <PrimaryButton onClick={onClose} variant="ghost" full>
            Keep it
          </PrimaryButton>
          <PrimaryButton onClick={submit} variant="danger" loading={submitting} full>
            Void invoice
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}

// ── Invoice row (Wise list-row pattern) ────────────────────────────────────

function InvoiceRow({
  inv,
  formatUsd,
  onOpen,
  onCopy,
  onVoid,
  divider,
}: {
  inv: Invoice;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  onOpen: () => void;
  onCopy: () => void;
  onVoid: () => void;
  divider: boolean;
}) {
  const tone =
    inv.status === "paid" ? "completed" : inv.status === "void" ? "danger" : "pending";
  const label =
    inv.status === "paid" ? "Paid" : inv.status === "void" ? "Void" : "Open";
  const title =
    inv.customerName ||
    (inv.lineItems[0]?.description ?? inv.memo ?? "Invoice");
  const created = new Date(inv.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  // Stop a button click from also triggering the row's navigate.
  const guard = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-[#15300c]/[0.04]"
        aria-label={`Open invoice ${title}`}
      >
        {/* Circular icon chip */}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={Invoice01Icon} size={17} strokeWidth={1.8} />
        </span>

        {/* Title + meta */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-[#15300c]">{title}</span>
          <span className="block truncate font-mono text-[11px] text-[#3d7a29]">
            {inv.id.slice(0, 8)}… · {created}
          </span>
        </span>

        {/* Amount + status */}
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className="text-[15px] font-semibold text-[#15300c]"
            style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.05em" }}
          >
            {formatUsd(inv.amountUsd, { fixed: true })}
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

      {/* Inline actions for open invoices */}
      {inv.status === "open" && (
        <div className="flex items-center gap-1 px-4 pb-3 pt-0">
          <button
            type="button"
            onClick={guard(onCopy)}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 text-[12px] text-[#3a5230] backdrop-blur-sm transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c]"
          >
            <HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={2} />
            Copy link
          </button>
          <button
            type="button"
            onClick={guard(onVoid)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-[#3d7a29] transition-colors hover:text-[#c0532f]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            Void
          </button>
        </div>
      )}

      {/* Copy link on non-open invoices */}
      {inv.status !== "open" && (
        <div className="flex items-center gap-1 px-4 pb-3 pt-0">
          <button
            type="button"
            onClick={guard(onCopy)}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 text-[12px] text-[#3a5230] backdrop-blur-sm transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c]"
          >
            <HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={2} />
            Copy link
          </button>
        </div>
      )}

      {divider && <div className="mx-4 border-t border-[#15300c]/10" />}
    </div>
  );
}

// ── Create invoice sheet ───────────────────────────────────────────────────

function CreateInvoiceSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const { currencies, currency: displayCurrency, toUsd } = useCurrency();
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [memo, setMemo] = useState("");
  const [dueDate, setDueDate] = useState(""); // yyyy-mm-dd from <input type="date">
  const [currency, setCurrency] = useState(displayCurrency || "USD");
  const [items, setItems] = useState<LineItem[]>([
    { description: "", qty: "1", unitUsd: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);

  // Keep the picker defaulting to the user's display currency when opened.
  useEffect(() => {
    if (open) setCurrency(displayCurrency || "USD");
  }, [open, displayCurrency]);

  const total = useMemo(() => {
    return (
      Math.round(
        items.reduce((acc, li) => {
          const q = Number(li.qty);
          const u = Number(li.unitUsd);
          if (!Number.isFinite(q) || !Number.isFinite(u)) return acc;
          return acc + Math.max(0, q) * Math.max(0, u);
        }, 0) * 100
      ) / 100
    );
  }, [items]);

  const symbol = useMemo(
    () => currencies.find((c) => c.code === currency)?.symbol ?? "$",
    [currencies, currency]
  );
  const money = (n: number) =>
    `${symbol}${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const setItem = (i: number, patch: Partial<LineItem>) =>
    setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () =>
    setItems((cur) => [...cur, { description: "", qty: "1", unitUsd: "" }]);
  const removeItem = (i: number) =>
    setItems((cur) => (cur.length === 1 ? cur : cur.filter((_, idx) => idx !== i)));

  const reset = () => {
    setCustomerName("");
    setCustomerEmail("");
    setMemo("");
    setDueDate("");
    setItems([{ description: "", qty: "1", unitUsd: "" }]);
  };

  const canSubmit =
    !submitting &&
    total > 0 &&
    items.some((it) => it.description.trim() && Number(it.unitUsd) > 0);

  const submit = async () => {
    const cleaned = items
      .filter((it) => it.description.trim() && Number(it.unitUsd) > 0)
      .map((it) => ({
        description: it.description.trim(),
        qty: Math.max(1, Number(it.qty) || 1),
        // The unit price is typed in the invoice's display currency, convert
        // back to USD before it's stored (₦50 must become $0.036, not $50).
        unitUsd: toUsd(Number(it.unitUsd), currency),
      }));
    if (cleaned.length === 0) {
      toast("Add at least one line item", "danger");
      return;
    }
    // Turn the picked calendar day into an epoch-ms due date. Use UTC end-of-day
    // so "due May 5" reads as May 5 everywhere regardless of the viewer's tz.
    let dueMs: number | undefined;
    if (dueDate) {
      const t = Date.parse(`${dueDate}T23:59:59Z`);
      if (Number.isFinite(t)) dueMs = t;
    }

    setSubmitting(true);
    try {
      const r = await api<{ payUrl: string }>("/api/invoices", {
        method: "POST",
        body: {
          currency,
          customerName: customerName.trim() || undefined,
          customerEmail: customerEmail.trim() || undefined,
          memo: memo.trim() || undefined,
          dueMs,
          lineItems: cleaned,
        },
      });
      try {
        await navigator.clipboard.writeText(r.payUrl);
        toast("Invoice created, pay link copied", "success");
      } catch {
        toast("Invoice created", "success");
      }
      reset();
      onCreated();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't create invoice", "danger");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New invoice" size="lg">
      <div className="space-y-4">
        {/* Customer details */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer name" hint="Shown on the invoice (optional)">
            <input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Acme Inc."
              className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
            />
          </Field>
          <Field label="Customer email" hint="For your records only (optional)">
            <input
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="billing@acme.com"
              type="email"
              className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency" hint="Display only, settles 1:1 as USDsui">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm focus:ring-2 focus:ring-[#3d7a29]/45"
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code} className="bg-[#f7fcf2] text-[#15300c]">
                  {c.code}, {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date" hint="When payment is expected (optional)">
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm focus:ring-2 focus:ring-[#3d7a29]/45"
            />
          </Field>
        </div>

        {/* Line items */}
        <div>
          <Eyebrow className="mb-2.5 block">Line items</Eyebrow>
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={it.description}
                  onChange={(e) => setItem(i, { description: e.target.value })}
                  placeholder="Design work, week 1"
                  className="min-w-0 flex-1 rounded-xl border border-[#15300c]/15 bg-white/60 px-3 py-2.5 text-[14px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
                />
                <input
                  value={it.qty}
                  onChange={(e) => setItem(i, { qty: e.target.value.replace(/[^\d.]/g, "") })}
                  inputMode="decimal"
                  aria-label="Quantity"
                  className="w-14 rounded-xl border border-[#15300c]/15 bg-white/60 px-2.5 py-2.5 text-center text-[14px] text-[#15300c] outline-none backdrop-blur-sm focus:ring-2 focus:ring-[#3d7a29]/45"
                  style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                />
                <div className="flex w-24 items-center rounded-xl border border-[#15300c]/15 bg-white/60 px-2.5 py-2.5 backdrop-blur-sm focus-within:ring-2 focus-within:ring-[#3d7a29]/45">
                  <span className="text-[13px] text-[#3d7a29]">{symbol}</span>
                  <input
                    value={it.unitUsd}
                    onChange={(e) =>
                      setItem(i, { unitUsd: e.target.value.replace(/[^\d.]/g, "") })
                    }
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label="Unit price"
                    className="w-full bg-transparent pl-1 text-right text-[14px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
                    style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  disabled={items.length === 1}
                  aria-label="Remove line item"
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl text-[#3d7a29] transition-colors hover:text-[#c0532f] disabled:opacity-30"
                >
                  <HugeiconsIcon icon={Delete02Icon} size={16} strokeWidth={1.8} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addItem}
            className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] text-[#3d7a29] transition-opacity hover:opacity-80"
          >
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
            Add line item
          </button>
        </div>

        <Field label="Note" hint="Optional message to the payer">
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Thanks for your business!"
            className="w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
          />
        </Field>

        {/* Live total */}
        <div className="flex items-center justify-between rounded-xl border border-[#15300c]/10 bg-white/60 px-4 py-3.5 backdrop-blur-sm">
          <span className="text-[14px] text-[#3a5230]">Invoice total</span>
          <span
            className="text-[22px] font-semibold text-[#15300c]"
            style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.05em" }}
          >
            {money(total)}
          </span>
        </div>

        <PrimaryButton onClick={submit} disabled={!canSubmit} loading={submitting} full>
          Create invoice &amp; copy pay link
        </PrimaryButton>
      </div>
    </Sheet>
  );
}
