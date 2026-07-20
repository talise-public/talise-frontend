"use client";

/**
 * RulesView, programmable money / automations (/app/rules).
 *
 * A rule pairs a TRIGGER with an ACTION; for launch the one executable action
 * is a scheduled `send` ("pay rent on the 1st", "send $50 every week"). Each
 * rule is NON-CUSTODIAL, it's backed by an on-chain `standing_order` pot the
 * user owns, funded up front with one-or-more payments' worth. A backend worker
 * can only release the pre-set amount to the pre-set recipient on schedule;
 * cancelling refunds the remaining pot.
 *
 * Create is a two-step prepare → sign → record (same sponsored-bytes path as the
 * goal vault / cheques / streams, `signSponsorReadyBytes`):
 *   • GET  /api/rules            → { rules, enabled }. `enabled === false` means
 *                                  the feature isn't switched on yet → we render
 *                                  a clean "coming soon" state.
 *   • POST /api/rules            → PREPARE: returns sponsor-ready `create` bytes.
 *   • POST /api/rules/record     → activate with the signed funding digest.
 *   • POST /api/rules/{id}/cancel→ owner-signed `cancel` bytes (refund the pot);
 *                                  sign, then DELETE /api/rules/{id} to clear it.
 *   • POST /api/rules/{id}/pause | /resume.
 *
 * Matches the v2 app look and reuses the shared primitives + the cookie-authed
 * `api` client.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  PlusSignIcon,
  PlayIcon,
  PauseIcon,
  Delete02Icon,
  RepeatIcon,
  Alert02Icon,
} from "@hugeicons/core-free-icons";
import {
  GlassCard,
  PrimaryButton,
  StatusPill,
  Sheet,
  Field,
  Segmented,
  Eyebrow,
  EmptyState,
  Spinner,
  api,
  ApiError,
  useToast,
  useCurrency,
} from "@/components/app";
import { signSponsorReadyBytes, friendlyError } from "@/components/app/cheques/signBytes";

type RuleState = "active" | "paused" | "deleted" | string;

type SendConfig = { toAddress?: string; toHandle?: string | null; amountMicros?: string };

type MoneyRule = {
  id: string;
  name: string;
  triggerType: "schedule" | "on-inflow" | "threshold";
  intervalMinutes: number | null;
  dayOfMonth: number | null;
  actionType: "send" | "sweep-earn";
  actionConfig: SendConfig;
  state: RuleState;
  nextDueAt: number | null;
  executionCount: number;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: number;
};

/** Echoed by POST /api/rules; re-posted (with digest + firstDueMs) to /record. */
type RuleRecord = {
  name: string;
  trigger: string;
  intervalMinutes: number | null;
  dayOfMonth: number | null;
  toAddress: string;
  toHandle: string | null;
  amountUsd: number;
};

type PrepareResp = {
  mode: string;
  bytes: string;
  firstDueMs: number;
  record: RuleRecord;
};

type CancelResp = { mode: string; bytes: string };

type Cadence = "monthly" | "weekly" | "daily" | "hourly";

const WEEK_MIN = 7 * 24 * 60;
const DAY_MIN = 24 * 60;

/** Map a cadence choice to the API's interval/day-of-month shape. */
function cadencePayload(cadence: Cadence, dayOfMonth: number): {
  intervalMinutes?: number;
  dayOfMonth?: number;
} {
  switch (cadence) {
    case "monthly":
      return { dayOfMonth };
    case "weekly":
      return { intervalMinutes: WEEK_MIN };
    case "daily":
      return { intervalMinutes: DAY_MIN };
    case "hourly":
      return { intervalMinutes: 60 };
  }
}

const ORDINAL = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** Human cadence label for a rule row. */
function describeCadence(rule: MoneyRule): string {
  if (rule.dayOfMonth) return `Monthly on the ${ORDINAL(rule.dayOfMonth)}`;
  const iv = rule.intervalMinutes;
  if (iv == null) return "On a schedule";
  if (iv === 60) return "Hourly";
  if (iv === DAY_MIN) return "Daily";
  if (iv === WEEK_MIN) return "Weekly";
  if (iv % DAY_MIN === 0) return `Every ${iv / DAY_MIN} days`;
  if (iv % 60 === 0) return `Every ${iv / 60} hours`;
  return `Every ${iv} min`;
}

function shortAddr(a: string): string {
  if (!a || a.length <= 14) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

export function RulesView() {
  const { toast } = useToast();
  const [rules, setRules] = useState<MoneyRule[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<MoneyRule | null>(null);

  // Feature switch: the API returns enabled:true only when the automations
  // engine is configured server-side. false ⇒ automations aren't live yet.
  const load = useCallback(async () => {
    try {
      const r = await api<{ rules: MoneyRule[]; enabled: boolean }>("/api/rules");
      setRules(r.rules ?? []);
      setEnabled(r.enabled === true);
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fire due rules on open, there is NO cron. `execute_due` is permissionless
  // on-chain, so the owner's open app triggers any due scheduled payment:
  // prepare → sign → record. The contract is the gate (it aborts ENotDue if a
  // rule isn't actually due), so every step here is best-effort and safe to skip.
  const firedRef = useRef(false);
  const fireDueRules = useCallback(async (current: MoneyRule[]) => {
    const now = Date.now();
    const due = current.filter(
      (r) => r.state === "active" && r.triggerType === "schedule" && r.nextDueAt != null && r.nextDueAt <= now,
    );
    if (due.length === 0) return;
    let fired = 0;
    for (const rule of due) {
      try {
        const prep = await api<{ mode: string; bytes: string }>(`/api/rules/${rule.id}/execute`, { method: "POST" });
        const { digest } = await signSponsorReadyBytes(prep.bytes, { kind: "rule-execute" });
        await api(`/api/rules/${rule.id}/executed`, { method: "POST", body: { digest } });
        fired++;
      } catch {
        // ENotDue / NO_ORDER / transient, the contract is the gate; just skip.
      }
    }
    if (fired > 0) {
      toast(`Ran ${fired} scheduled payment${fired > 1 ? "s" : ""}`, "neutral");
      await load();
    }
  }, [toast, load]);

  useEffect(() => {
    if (loading || firedRef.current || !enabled) return;
    firedRef.current = true;
    void fireDueRules(rules);
  }, [loading, enabled, rules, fireDueRules]);

  const toggle = async (rule: MoneyRule) => {
    const action = rule.state === "active" ? "pause" : "resume";
    setBusyId(rule.id);
    try {
      await api(`/api/rules/${rule.id}/${action}`, { method: "POST" });
      toast(action === "pause" ? "Rule paused" : "Rule resumed", "neutral");
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't update rule", "danger");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Automations
        </div>
        <h1
          className="mt-2 text-[clamp(24px,4vw,34px)] font-[500] tracking-[-0.05em] text-[#15300c]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          Money that runs itself.
        </h1>
        <p className="mt-2 max-w-xl text-[14px] leading-[1.5] text-[#3a5230]">
          Set a rule once and Talise pays it on schedule, rent on the 1st, an
          allowance every week. Funded from your Rules Pocket, sent gaslessly.
        </p>
      </header>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={22} />
        </div>
      ) : !enabled ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={<HugeiconsIcon icon={RepeatIcon} size={26} strokeWidth={1.6} />}
            title="Automations, coming soon"
            subtitle="Scheduled, hands-off payments are almost here. You'll be able to set a rule and let it run."
          />
        </GlassCard>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <Eyebrow>Your rules</Eyebrow>
            <PrimaryButton onClick={() => setCreateOpen(true)} variant="ghost">
              <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
              New rule
            </PrimaryButton>
          </div>

          {rules.length === 0 ? (
            <GlassCard className="p-2">
              <EmptyState
                icon={<HugeiconsIcon icon={RepeatIcon} size={26} strokeWidth={1.6} />}
                title="No rules yet"
                subtitle="Create a scheduled payment and let it run on its own."
                action={
                  <PrimaryButton onClick={() => setCreateOpen(true)}>
                    <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
                    New rule
                  </PrimaryButton>
                }
              />
            </GlassCard>
          ) : (
            <GlassCard className="overflow-hidden p-0">
              {rules.map((rule, i) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  busy={busyId === rule.id}
                  onToggle={() => toggle(rule)}
                  onDelete={() => setDeleteFor(rule)}
                  divider={i < rules.length - 1}
                />
              ))}
            </GlassCard>
          )}
        </>
      )}

      <CreateRuleSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void load();
        }}
        onDisabled={() => {
          setCreateOpen(false);
          setEnabled(false);
        }}
      />

      <DeleteSheet
        rule={deleteFor}
        onClose={() => setDeleteFor(null)}
        onDone={() => {
          setDeleteFor(null);
          void load();
        }}
      />
    </div>
  );
}

// ── Rule row ───────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  busy,
  onToggle,
  onDelete,
  divider,
}: {
  rule: MoneyRule;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
  divider: boolean;
}) {
  const { formatUsd } = useCurrency();
  const paused = rule.state === "paused";
  const amountUsd = rule.actionConfig?.amountMicros
    ? Number(BigInt(rule.actionConfig.amountMicros)) / 1e6
    : 0;
  const to =
    rule.actionConfig?.toHandle ||
    (rule.actionConfig?.toAddress ? shortAddr(rule.actionConfig.toAddress) : "recipient");

  return (
    <div>
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={RepeatIcon} size={17} strokeWidth={1.8} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-[#15300c]">{rule.name}</span>
          <span className="block truncate font-mono text-[11px] text-[#3d7a29]">
            {describeCadence(rule)} · to {to}
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className="text-[15px] font-semibold text-[#15300c]"
            style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.05em" }}
          >
            {formatUsd(amountUsd, { fixed: true })}
          </span>
          <StatusPill label={paused ? "Paused" : "Active"} tone={paused ? "paused" : "active"} />
        </span>
      </div>

      <div className="flex items-center gap-1 px-4 pb-3 pt-0">
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 text-[12px] text-[#3a5230] backdrop-blur-sm transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c] disabled:opacity-50"
        >
          <HugeiconsIcon icon={paused ? PlayIcon : PauseIcon} size={12} strokeWidth={2} />
          {paused ? "Resume" : "Pause"}
        </button>
        {rule.executionCount > 0 && (
          <span className="ml-1 font-mono text-[11px] text-[#3d7a29]">
            {rule.executionCount} run{rule.executionCount === 1 ? "" : "s"}
          </span>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-[#3d7a29] transition-colors hover:text-[#c0532f]"
        >
          <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={2} />
          Cancel
        </button>
      </div>

      {rule.lastStatus === "error" && rule.lastError && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-xl border border-[#c0532f]/25 bg-[rgba(255,158,122,0.15)] px-3 py-2 text-[12px] text-[#c0532f]">
          <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={2} className="mt-px shrink-0" />
          <span className="min-w-0">{rule.lastError}</span>
        </div>
      )}

      {divider && <div className="mx-4 border-t border-[#15300c]/10" />}
    </div>
  );
}

// ── Create rule sheet ─────────────────────────────────────────────────────────

function CreateRuleSheet({
  open,
  onClose,
  onCreated,
  onDisabled,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onDisabled: () => void;
}) {
  const { toast } = useToast();
  const { formatUsd } = useCurrency();
  const [name, setName] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  // How many payments' worth to load into the rule's pot up front (default 1).
  const [payments, setPayments] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setRecipient("");
      setAmount("");
      setCadence("monthly");
      setDayOfMonth("1");
      setPayments(1);
    }
  }, [open]);

  const amountUsd = useMemo(() => {
    const v = parseFloat(amount);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [amount]);

  const dom = useMemo(() => {
    const v = parseInt(dayOfMonth, 10);
    return Number.isFinite(v) && v >= 1 && v <= 31 ? v : 1;
  }, [dayOfMonth]);

  // Round to cents so the funding figure matches what's signed on chain.
  const prefundUsd = amountUsd == null ? null : Math.round(amountUsd * payments * 100) / 100;

  const canSubmit = !submitting && name.trim() && recipient.trim() && amountUsd != null;

  const submit = async () => {
    if (!canSubmit || amountUsd == null || prefundUsd == null) return;
    setSubmitting(true);
    try {
      // 1) PREPARE, server validates + screens, returns sponsor-ready
      //    `standing_order::create` bytes that fund the rule's pot.
      const prep = await api<PrepareResp>("/api/rules", {
        method: "POST",
        body: {
          name: name.trim(),
          trigger: "schedule",
          action: "send",
          toRecipient: recipient.trim(),
          amountUsd,
          prefundUsd,
          ...cadencePayload(cadence, dom),
        },
      });

      // 2) SIGN, same sponsored-bytes path as the goal vault / cheques / streams.
      const { digest } = await signSponsorReadyBytes(prep.bytes, { kind: "rule-create" });

      // 3) RECORD, activate the rule with the funding digest + echoed record.
      await api("/api/rules/record", {
        method: "POST",
        body: { digest, firstDueMs: prep.firstDueMs, ...prep.record },
      });

      toast("Rule created", "success");
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && (err.code === "MONEY_RULES_DISABLED" || err.status === 503)) {
        toast("Automations aren't available yet", "neutral");
        onDisabled();
        return;
      }
      toast(friendlyError(err, "Couldn't create rule", "Automations"), "danger");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 text-[15px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45";

  return (
    <Sheet open={open} onClose={onClose} title="New rule" size="lg">
      <div className="space-y-4">
        <Field label="Name" hint="What this rule is for">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 80))}
            placeholder="Rent"
            className={inputCls}
          />
        </Field>

        <Field label="Pay to" hint="A @handle or 0x address">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="landlord@talise or 0x…"
            className={inputCls}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" hint="Per run, in USD">
            <div className="flex items-center gap-1.5 rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 backdrop-blur-sm focus-within:ring-2 focus-within:ring-[#3d7a29]/45">
              <span className="text-[18px] text-[#3a5230]" style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>
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
                className="w-full bg-transparent text-[18px] font-[700] text-[#15300c] tabular-nums outline-none placeholder:text-[#3d7a29]"
              />
            </div>
          </Field>

          <Field label="How often" hint="When this rule runs">
            <Segmented<Cadence>
              ariaLabel="How often"
              value={cadence}
              onChange={setCadence}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "weekly", label: "Weekly" },
                { value: "daily", label: "Daily" },
                { value: "hourly", label: "Hourly" },
              ]}
            />
          </Field>
        </div>

        {cadence === "monthly" && (
          <Field label="Day of month" hint="1–31 (clamped to the last day in shorter months)">
            <input
              value={dayOfMonth}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
                setDayOfMonth(v);
              }}
              inputMode="numeric"
              placeholder="1"
              className={inputCls}
              style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
            />
          </Field>
        )}

        <Field label="Load the pot" hint="How much to fund up front, the rule pays from its own pot">
          <Segmented<number>
            ariaLabel="How many payments to fund up front"
            value={payments}
            onChange={setPayments}
            options={[1, 3, 6, 12].map((n) => ({ value: n, label: `${n}×` }))}
          />
        </Field>

        {amountUsd != null && prefundUsd != null && (
          <p className="text-[12px] text-[#3a5230]">
            Funds the rule&apos;s pot, {payments} payment{payments === 1 ? "" : "s"} of{" "}
            {formatUsd(amountUsd, { fixed: true })} ({formatUsd(prefundUsd, { fixed: true })} total).
          </p>
        )}

        <PrimaryButton onClick={submit} disabled={!canSubmit} loading={submitting} full>
          Create rule
        </PrimaryButton>
        <p className="text-center text-[12px] text-[#3d7a29]">
          You&apos;ll sign once to fund the pot. Payouts pull from it gaslessly, and the
          remaining balance is refunded if you cancel.
        </p>
      </div>
    </Sheet>
  );
}

// ── Delete sheet ───────────────────────────────────────────────────────────

function DeleteSheet({
  rule,
  onClose,
  onDone,
}: {
  rule: MoneyRule | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!rule) return;
    setSubmitting(true);
    try {
      // 1) CANCEL, fetch the owner-signed `cancel` bytes (refunds the pot).
      //    409/NO_ORDER means there's no on-chain pot to refund → just DELETE.
      try {
        const cancel = await api<CancelResp>(`/api/rules/${rule.id}/cancel`, { method: "POST" });
        await signSponsorReadyBytes(cancel.bytes, { kind: "rule-cancel" });
      } catch (err) {
        const noOrder =
          err instanceof ApiError && (err.code === "NO_ORDER" || err.status === 409);
        if (!noOrder) throw err;
      }
      // 2) DELETE, clear the row.
      await api(`/api/rules/${rule.id}`, { method: "DELETE" });
      toast("Rule cancelled", "neutral");
      onDone();
    } catch (err) {
      toast(friendlyError(err, "Couldn't cancel rule", "Automations"), "danger");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={!!rule} onClose={onClose} title="Cancel rule">
      <div className="space-y-4">
        <p className="text-[14px] text-[#3a5230]">
          Cancelling <span className="font-medium text-[#15300c]">{rule?.name}</span> stops it from
          running and refunds the remaining pot to your wallet. You&apos;ll sign once to release
          the funds.
        </p>
        <div className="flex items-center gap-2">
          <PrimaryButton onClick={onClose} variant="ghost" full>
            Keep it
          </PrimaryButton>
          <PrimaryButton onClick={submit} variant="danger" loading={submitting} full>
            Cancel &amp; refund
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}

export default RulesView;
