import "server-only";

import { randomBytes } from "node:crypto";
import { db, ensureSchema, schemaVersionGate } from "@/lib/db";
import {
  automationsEnabled,
  buildCreateOrderSponsored,
  buildCancelOrderSponsored,
  buildExecuteDueSponsored,
  parseCreatedOrderId,
} from "@/lib/automations";

/**
 * Programmable money / rules, money that runs itself, NON-CUSTODIALLY.
 *
 * A rule pairs a TRIGGER (schedule | on-inflow | threshold) with an ACTION. For
 * launch the only action is a scheduled `send` ("pay rent on the 1st", "send mum
 * $50 weekly").
 *
 * Each rule is backed by an on-chain `talise_automations::standing_order` object
 * (the audited, non-custodial primitive). The SMART CONTRACT is the automation -
 * there is no cron and no scheduler key:
 *   • CREATE, the user signs an Onara-sponsored `standing_order::create` that
 *     funds the rule's pot (they own the object; only THEY can cancel/withdraw).
 *   • EXECUTE, `execute_due` is PERMISSIONLESS; the owner's app triggers any due
 *     rules when it's open (Onara-sponsored, owner-signed). The contract releases
 *     the pre-set `amount_per` to the pre-set `recipient` only once the Clock
 *     passes `next_due_ms`, the caller can't change destination, amount, or fire
 *     early, so triggering is trustless.
 *   • CANCEL, the user signs `cancel`, which refunds the entire remaining pot.
 *
 * The DB row mirrors the on-chain schedule for display + to surface which rules
 * are due to trigger; the money + the authoritative cursor live on chain. Gated
 * by automationsEnabled() (AUTOMATIONS_PACKAGE_ID + REGISTRY_ID), unset → off.
 */

export function moneyRulesEnabled(): boolean {
  return automationsEnabled();
}

// ── Constants ────────────────────────────────────────────────────────────────
export const MIN_SEND_MICROS = 10_000n; // 0.01 USDsui, the gasless minimum per leg
export const MAX_SEND_MICROS = 10_000_000_000n; // 10,000 USDsui, per-execution ceiling
const MIN_INTERVAL_MINUTES = 1;
const THRESHOLD_RECHECK_MS = 3_600_000; // re-evaluate threshold/on-inflow rules hourly
const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

export type TriggerType = "schedule" | "on-inflow" | "threshold";
export type ActionType = "send" | "sweep-earn";
export type RuleState = "active" | "paused" | "deleted";

// ── Schema ─────────────────────────────────────────────────────────────────
let _schemaReady: Promise<void> | null = null;
const SCHEMA_VERSION = "2026-06-28.2";

export function ensureMoneyRulesSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await ensureSchema();
    const c = db();
    const gate = await schemaVersionGate("money_rules_schema_version", SCHEMA_VERSION);
    if (gate.upToDate) return;

    await c.execute(`
      CREATE TABLE IF NOT EXISTS money_rules (
        id                        TEXT PRIMARY KEY,
        user_id                   INTEGER NOT NULL,
        owner_address             TEXT NOT NULL,
        name                      TEXT NOT NULL,
        trigger_type              TEXT NOT NULL,
        schedule_cron             TEXT,
        schedule_interval_minutes BIGINT,
        schedule_day_of_month     INTEGER,
        inflow_min_usd            BIGINT,
        balance_threshold_usd     BIGINT,
        condition_type            TEXT,
        condition_value_micros    BIGINT,
        action_type               TEXT NOT NULL,
        action_config             TEXT NOT NULL DEFAULT '{}',
        order_object_id           TEXT,
        state                     TEXT NOT NULL DEFAULT 'active',
        next_due_at               BIGINT,
        execution_count           INTEGER NOT NULL DEFAULT 0,
        last_run_at               BIGINT,
        last_status               TEXT,
        last_error                TEXT,
        created_at                BIGINT NOT NULL,
        updated_at                BIGINT NOT NULL,
        deleted_at                BIGINT
      )
    `);
    // Backfill the on-chain order id column for any table created pre-2026-06-28.2.
    await c.execute(`ALTER TABLE money_rules ADD COLUMN IF NOT EXISTS order_object_id TEXT`);
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_money_rules_user ON money_rules(user_id, created_at DESC)`);
    // "Which rules are due to trigger" read (listDueRules), keyed on state + next due.
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_money_rules_due ON money_rules(state, next_due_at)`);

    // Append-only execution ledger; the unique index is the double-fire guard.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS money_rule_executions (
        id            SERIAL PRIMARY KEY,
        rule_id       TEXT NOT NULL,
        triggered_at  BIGINT NOT NULL,
        action_type   TEXT,
        amount_micros BIGINT,
        recipient     TEXT,
        digests       TEXT,
        status        TEXT NOT NULL,
        error         TEXT,
        created_at    BIGINT NOT NULL
      )
    `);
    await c.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_money_rule_execution ON money_rule_executions(rule_id, triggered_at)`);

    await gate.stamp();
  })().catch((err) => {
    _schemaReady = null;
    throw err;
  });
  return _schemaReady;
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface SendActionConfig {
  toAddress: string;
  toHandle?: string | null;
  amountMicros: string; // BigInt micros as string
}

interface Row {
  id: string;
  user_id: number;
  owner_address: string;
  name: string;
  trigger_type: string;
  schedule_cron: string | null;
  schedule_interval_minutes: number | string | null;
  schedule_day_of_month: number | null;
  inflow_min_usd: number | string | null;
  balance_threshold_usd: number | string | null;
  condition_type: string | null;
  condition_value_micros: number | string | null;
  action_type: string;
  action_config: string;
  order_object_id: string | null;
  state: string;
  next_due_at: number | string | null;
  execution_count: number;
  last_run_at: number | string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number | string;
  updated_at: number | string;
  deleted_at: number | string | null;
}

export interface MoneyRule {
  id: string;
  userId: number;
  ownerAddress: string;
  name: string;
  triggerType: TriggerType;
  scheduleCron: string | null;
  intervalMinutes: number | null;
  dayOfMonth: number | null;
  inflowMinUsd: number | null;
  balanceThresholdUsd: number | null;
  conditionType: string | null;
  conditionValueUsd: number | null;
  actionType: ActionType;
  actionConfig: Record<string, unknown>;
  orderObjectId: string | null;
  state: string;
  nextDueAt: number | null;
  executionCount: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const usd = (micros: number | string | null) => (micros == null ? null : Number(BigInt(micros)) / 1e6);
const num = (v: number | string | null) => (v == null ? null : Number(v));

function project(row: Row): MoneyRule {
  let actionConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.action_config || "{}");
    if (parsed && typeof parsed === "object") actionConfig = parsed as Record<string, unknown>;
  } catch { /* tolerate */ }
  return {
    id: row.id,
    userId: Number(row.user_id),
    ownerAddress: row.owner_address,
    name: row.name,
    triggerType: row.trigger_type as TriggerType,
    scheduleCron: row.schedule_cron,
    intervalMinutes: num(row.schedule_interval_minutes),
    dayOfMonth: row.schedule_day_of_month == null ? null : Number(row.schedule_day_of_month),
    inflowMinUsd: usd(row.inflow_min_usd),
    balanceThresholdUsd: usd(row.balance_threshold_usd),
    conditionType: row.condition_type,
    conditionValueUsd: usd(row.condition_value_micros),
    actionType: row.action_type as ActionType,
    actionConfig,
    orderObjectId: row.order_object_id,
    state: row.state,
    nextDueAt: num(row.next_due_at),
    executionCount: Number(row.execution_count),
    lastRunAt: num(row.last_run_at),
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ── Schedule math ─────────────────────────────────────────────────────────────

/**
 * Compute the next due timestamp for a rule, measured from `fromMs`.
 *  • schedule + interval     → fromMs + interval
 *  • schedule + day-of-month → the next calendar occurrence of that day (12:00 UTC)
 *  • threshold / on-inflow   → fromMs + hourly recheck
 * Returns null only when a schedule rule has neither an interval nor a DOM (invalid).
 */
export function computeNextDue(rule: {
  triggerType: TriggerType;
  intervalMinutes: number | null;
  dayOfMonth: number | null;
}, fromMs: number): number | null {
  if (rule.triggerType === "schedule") {
    if (rule.intervalMinutes && rule.intervalMinutes >= MIN_INTERVAL_MINUTES) {
      return fromMs + rule.intervalMinutes * 60_000;
    }
    if (rule.dayOfMonth && rule.dayOfMonth >= 1 && rule.dayOfMonth <= 31) {
      return nextDayOfMonth(rule.dayOfMonth, fromMs);
    }
    return null;
  }
  // threshold + on-inflow are polled on a fixed recheck cadence.
  return fromMs + THRESHOLD_RECHECK_MS;
}

/** Next 12:00-UTC timestamp landing on the given day-of-month, strictly after `fromMs`. */
function nextDayOfMonth(dom: number, fromMs: number): number {
  const from = new Date(fromMs);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth(); // 0-based
  for (let i = 0; i < 14; i++) {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(dom, daysInMonth); // clamp 31→28/30 etc.
    const candidate = Date.UTC(year, month, day, 12, 0, 0, 0);
    if (candidate > fromMs) return candidate;
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  // Unreachable in practice; fall back to ~30 days out.
  return fromMs + 30 * 24 * 3_600_000;
}

// ── Create / read / mutate ────────────────────────────────────────────────────
export function newRuleId(): string {
  return `rule_${randomBytes(12).toString("hex")}`;
}

export interface CreateRuleInput {
  userId: number;
  ownerAddress: string;
  name: string;
  triggerType: TriggerType;
  // schedule
  intervalMinutes?: number | null;
  dayOfMonth?: number | null;
  // on-inflow
  inflowMinMicros?: bigint | null;
  // threshold
  balanceThresholdMicros?: bigint | null;
  // action
  actionType: ActionType;
  send?: { toAddress: string; toHandle?: string | null; amountMicros: bigint };
}

interface NormalizedRule {
  name: string;
  intervalMinutes: number | null;
  dayOfMonth: number | null;
  inflowMinMicros: bigint | null;
  balanceThresholdMicros: bigint | null;
  to: string;
  toHandle: string | null;
  amountMicros: bigint;
  /** Fixed cadence the on-chain order advances by each release. */
  intervalMs: number;
}

/** Shared validation for both prepare + record so the recorded rule always
 *  matches what was signed (never trusts un-revalidated client input). */
function validateRule(input: CreateRuleInput): NormalizedRule {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Give this rule a name.");
  if (name.length > 80) throw new Error("That name is too long.");
  if (input.triggerType !== "schedule" && input.triggerType !== "on-inflow" && input.triggerType !== "threshold") {
    throw new Error("Unknown trigger type.");
  }
  if (input.actionType !== "send") {
    // v1: only scheduled send is wired to the on-chain standing order.
    throw new Error("Only scheduled payments are available right now.");
  }

  let intervalMinutes: number | null = null;
  let dayOfMonth: number | null = null;
  let intervalMs = THRESHOLD_RECHECK_MS;
  if (input.triggerType === "schedule") {
    const iv = input.intervalMinutes == null ? null : Number(input.intervalMinutes);
    const dom = input.dayOfMonth == null ? null : Number(input.dayOfMonth);
    if (iv != null && Number.isFinite(iv) && iv >= MIN_INTERVAL_MINUTES) {
      intervalMinutes = Math.floor(iv);
      intervalMs = intervalMinutes * 60_000;
    } else if (dom != null && Number.isInteger(dom) && dom >= 1 && dom <= 31) {
      dayOfMonth = dom;
      intervalMs = 30 * 24 * 3_600_000; // monthly ≈ 30d fixed cadence (first due lands on the chosen day)
    } else {
      throw new Error("Choose how often this runs (an interval or a day of the month).");
    }
  }

  let balanceThresholdMicros: bigint | null = null;
  if (input.triggerType === "threshold") {
    balanceThresholdMicros = input.balanceThresholdMicros ?? null;
    if (balanceThresholdMicros == null || balanceThresholdMicros <= 0n) {
      throw new Error("Set the balance threshold for this rule.");
    }
    intervalMs = THRESHOLD_RECHECK_MS;
  }
  const inflowMinMicros = input.triggerType === "on-inflow" ? (input.inflowMinMicros ?? 0n) : null;

  if (!input.send) throw new Error("This rule has no payout configured.");
  const to = (input.send.toAddress ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(to)) throw new Error("The payout address looks invalid.");
  if (to === input.ownerAddress.trim().toLowerCase()) throw new Error("A rule can't pay your own wallet.");
  const amountMicros = input.send.amountMicros;
  if (amountMicros < MIN_SEND_MICROS) throw new Error("The payout amount must be at least 0.01 USDsui.");
  if (amountMicros > MAX_SEND_MICROS) throw new Error("That payout amount is too large.");

  return { name, intervalMinutes, dayOfMonth, inflowMinMicros, balanceThresholdMicros, to, toHandle: input.send.toHandle ?? null, amountMicros, intervalMs };
}

/**
 * STEP 1, validate the rule + return the Onara-sponsored `standing_order::create`
 * bytes the user signs to fund the rule's pot. `prefundMicros` (>= amount) is how
 * much to load now; the client can fund several periods up front. Moves no money
 * until the user signs.
 */
export async function prepareCreateRule(
  input: CreateRuleInput,
  prefundMicros: bigint
): Promise<{ bytes: string; sponsor: string; firstDueMs: number; intervalMs: number }> {
  await ensureMoneyRulesSchema();
  if (!automationsEnabled()) throw new Error("Automations aren't enabled yet.");
  const v = validateRule(input);
  if (prefundMicros < v.amountMicros) throw new Error("Fund at least one payment to start the rule.");
  const firstDueMs = computeNextDue({ triggerType: input.triggerType, intervalMinutes: v.intervalMinutes, dayOfMonth: v.dayOfMonth }, Date.now()) ?? Date.now() + v.intervalMs;
  const { bytes, sponsor } = await buildCreateOrderSponsored({
    sender: input.ownerAddress,
    recipient: v.to,
    amountPerMicros: v.amountMicros,
    intervalMs: v.intervalMs,
    firstDueMs,
    prefundMicros,
  });
  return { bytes, sponsor, firstDueMs, intervalMs: v.intervalMs };
}

/**
 * STEP 2, after the user signs the create, parse the new StandingOrder object id
 * from the funding `digest` and insert the ACTIVE rule. The DB row mirrors the
 * on-chain schedule (the cron reads `next_due_at` and triggers `execute_due`).
 */
export async function recordCreatedRule(
  input: CreateRuleInput,
  digest: string,
  firstDueMs: number
): Promise<MoneyRule> {
  await ensureMoneyRulesSchema();
  const v = validateRule(input);
  const orderId = await parseCreatedOrderId(digest);
  if (!orderId) throw new Error("Couldn't confirm the on-chain rule yet. Wait a moment and retry.");

  const now = Date.now();
  const id = newRuleId();
  const actionConfig: SendActionConfig = { toAddress: v.to, toHandle: v.toHandle, amountMicros: v.amountMicros.toString() };

  await db().execute({
    sql: `INSERT INTO money_rules
            (id, user_id, owner_address, name, trigger_type,
             schedule_interval_minutes, schedule_day_of_month,
             inflow_min_usd, balance_threshold_usd,
             action_type, action_config, order_object_id, state, next_due_at,
             execution_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
    args: [
      id, input.userId, input.ownerAddress, v.name, input.triggerType,
      v.intervalMinutes == null ? null : v.intervalMinutes,
      v.dayOfMonth == null ? null : v.dayOfMonth,
      v.inflowMinMicros == null ? null : v.inflowMinMicros.toString(),
      v.balanceThresholdMicros == null ? null : v.balanceThresholdMicros.toString(),
      input.actionType, JSON.stringify(actionConfig), orderId, firstDueMs, now, now,
    ],
  });
  return getRule(id, input.userId) as Promise<MoneyRule>;
}

/** Build the owner-signed `cancel` PTB (stops + refunds the pot). The route
 *  returns these bytes; on success the client calls deleteRule to clear the row. */
export async function prepareCancelRule(id: string, userId: number): Promise<{ bytes: string; sponsor: string } | null> {
  const rule = await getRule(id, userId);
  if (!rule || !rule.orderObjectId) return null;
  return buildCancelOrderSponsored({ sender: rule.ownerAddress, orderId: rule.orderObjectId });
}

export async function getRule(id: string, userId: number): Promise<MoneyRule | null> {
  await ensureMoneyRulesSchema();
  const r = await db().execute({
    sql: "SELECT * FROM money_rules WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1",
    args: [id, userId],
  });
  const row = r.rows[0] as unknown as Row | undefined;
  return row ? project(row) : null;
}

export async function listRules(userId: number): Promise<MoneyRule[]> {
  await ensureMoneyRulesSchema();
  const r = await db().execute({
    sql: "SELECT * FROM money_rules WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
    args: [userId],
  });
  return (r.rows as unknown as Row[]).map(project);
}

export async function pauseRule(id: string, userId: number): Promise<MoneyRule | null> {
  await ensureMoneyRulesSchema();
  await db().execute({
    sql: `UPDATE money_rules SET state = 'paused', updated_at = ?
           WHERE id = ? AND user_id = ? AND state = 'active' AND deleted_at IS NULL`,
    args: [Date.now(), id, userId],
  });
  return getRule(id, userId);
}

export async function resumeRule(id: string, userId: number): Promise<MoneyRule | null> {
  await ensureMoneyRulesSchema();
  // Re-arm next_due_at from now so a long-paused rule doesn't fire a backlog at once.
  const rule = await getRule(id, userId);
  if (!rule) return null;
  if (rule.state !== "paused") return rule;
  const nextDueAt = computeNextDue(rule, Date.now());
  await db().execute({
    sql: `UPDATE money_rules SET state = 'active', next_due_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND state = 'paused' AND deleted_at IS NULL`,
    args: [nextDueAt, Date.now(), id, userId],
  });
  return getRule(id, userId);
}

/** Soft-delete: the cron only ever reads state='active' AND deleted_at IS NULL. */
export async function deleteRule(id: string, userId: number): Promise<boolean> {
  await ensureMoneyRulesSchema();
  const now = Date.now();
  const r = await db().execute({
    sql: `UPDATE money_rules SET state = 'deleted', deleted_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [now, now, id, userId],
  });
  return (r.rowsAffected ?? 0) > 0;
}

// ── Client-triggered execution (no cron) ───────────────────────────────────────

/**
 * The active rules that are DUE to trigger for a user (schedule rules whose
 * `next_due_at` has passed and that have an on-chain order). The client fetches
 * these when the app opens and triggers each via prepare→sign→record. The
 * on-chain Clock is the real gate, so a stale `next_due_at` only ever means the
 * trigger no-ops with ENotDue, never an early or wrong payment.
 *
 * `threshold`/`on-inflow` rules aren't surfaced here: they need a balance check
 * the client can't authoritatively make, so they're held until that poller lands.
 */
export async function listDueRules(userId: number, nowMs: number = Date.now()): Promise<MoneyRule[]> {
  await ensureMoneyRulesSchema();
  const r = await db().execute({
    sql: `SELECT * FROM money_rules
           WHERE user_id = ? AND state = 'active' AND deleted_at IS NULL
             AND trigger_type = 'schedule' AND order_object_id IS NOT NULL
             AND next_due_at IS NOT NULL AND next_due_at <= ?
           ORDER BY next_due_at ASC LIMIT 50`,
    args: [userId, nowMs],
  });
  return (r.rows as unknown as Row[]).map(project);
}

/**
 * STEP 1 of a trigger, return the Onara-sponsored `execute_due` bytes for a due
 * rule the caller owns. Builds against the OWNER as sender (their app signs);
 * the contract still enforces the schedule, so this is safe even if the rule
 * isn't actually due (it would just abort ENotDue on submit). Returns null when
 * the rule has no on-chain order.
 */
export async function prepareExecuteRule(id: string, userId: number): Promise<{ bytes: string; sponsor: string } | null> {
  const rule = await getRule(id, userId);
  if (!rule || !rule.orderObjectId) return null;
  if (rule.state !== "active") return null;
  return buildExecuteDueSponsored({ sender: rule.ownerAddress, orderId: rule.orderObjectId });
}

/**
 * STEP 2 of a trigger, record a confirmed on-chain release. Advances the
 * `next_due_at` mirror by one interval, bumps the counter, and appends to the
 * ledger. Idempotent on (rule_id, triggered_at): a double-record is a no-op, and
 * the on-chain Clock already prevents a double PAY.
 */
export async function recordRuleExecuted(id: string, userId: number, digest: string): Promise<MoneyRule | null> {
  const rule = await getRule(id, userId);
  if (!rule) return null;
  const now = Date.now();
  const triggeredAt = rule.nextDueAt ?? now;
  const cfg = rule.actionConfig as Partial<SendActionConfig>;
  const to = (cfg.toAddress ?? "").trim().toLowerCase() || null;
  const amountMicros = cfg.amountMicros ? BigInt(cfg.amountMicros) : null;
  await recordExecution(rule, triggeredAt, "ok", to, amountMicros, null, [digest]);
  const nextDue = computeNextDue(rule, now);
  await db().execute({
    sql: `UPDATE money_rules
             SET next_due_at = ?, last_run_at = ?, last_status = 'ok', last_error = NULL,
                 execution_count = execution_count + 1, updated_at = ?
           WHERE id = ? AND user_id = ?`,
    args: [nextDue, now, now, id, userId],
  });
  return getRule(id, userId);
}

/** Append-only ledger write; idempotent on (rule_id, triggered_at). */
async function recordExecution(
  rule: MoneyRule,
  triggeredAt: number,
  status: "ok" | "error" | "skipped",
  recipient: string | null,
  amountMicros: bigint | null,
  error: string | null,
  digests?: string[],
): Promise<void> {
  await db().execute({
    sql: `INSERT INTO money_rule_executions
            (rule_id, triggered_at, action_type, amount_micros, recipient, digests, status, error, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (rule_id, triggered_at) DO NOTHING`,
    args: [
      rule.id, triggeredAt, rule.actionType,
      amountMicros == null ? null : amountMicros.toString(),
      recipient, digests ? JSON.stringify(digests) : null,
      status, error ? error.slice(0, 500) : null, Date.now(),
    ],
  });
}

export async function listRuleExecutions(ruleId: string, userId: number, limit = 50): Promise<Array<{
  triggeredAt: number;
  actionType: string | null;
  amountUsd: number | null;
  recipient: string | null;
  status: string;
  error: string | null;
  digests: string[];
  createdAt: number;
}>> {
  await ensureMoneyRulesSchema();
  // Ownership gate: only return executions for a rule the caller owns.
  const owns = await getRule(ruleId, userId);
  if (!owns) return [];
  const r = await db().execute({
    sql: `SELECT triggered_at, action_type, amount_micros, recipient, digests, status, error, created_at
            FROM money_rule_executions WHERE rule_id = ? ORDER BY triggered_at DESC LIMIT ?`,
    args: [ruleId, Math.min(Math.max(limit, 1), 200)],
  });
  return (r.rows as unknown as Array<{
    triggered_at: number | string;
    action_type: string | null;
    amount_micros: number | string | null;
    recipient: string | null;
    digests: string | null;
    status: string;
    error: string | null;
    created_at: number | string;
  }>).map((row) => {
    let digests: string[] = [];
    try { const p = JSON.parse(row.digests || "[]"); if (Array.isArray(p)) digests = p as string[]; } catch { /* tolerate */ }
    return {
      triggeredAt: Number(row.triggered_at),
      actionType: row.action_type,
      amountUsd: row.amount_micros == null ? null : Number(BigInt(row.amount_micros)) / 1e6,
      recipient: row.recipient,
      status: row.status,
      error: row.error,
      digests,
      createdAt: Number(row.created_at),
    };
  });
}
