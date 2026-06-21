import "server-only";

import { db } from "@/lib/db";
import { ensureWorkSchema } from "@/lib/invoices";
import { streamById, projectStream } from "@/lib/streams";

/**
 * Work contracts — the Work hub's "pay your team" backend.
 *
 * A contract is an employment/freelance arrangement that pays out via an
 * underlying STREAM (web/lib/streams.ts). The stream does the money movement
 * (escrow-funded, cron-released tranches); this row holds the human-facing
 * arrangement metadata — role title, rate per period, cadence — and links the
 * `stream_id` so the list view can render "pays @alice $X every week for N
 * weeks" without re-deriving it from raw tranche micros.
 *
 * The contract table itself is created by `ensureWorkSchema()` (in
 * web/lib/invoices.ts) — both Work tables share one bootstrap so we never run
 * two competing migrations. This module only reads/writes it.
 */

// ── Cadence model ───────────────────────────────────────────────────────────

export type Cadence = "hourly" | "daily" | "weekly" | "monthly";

/** cadence → interval in ms (a "month" is a flat 30 days for scheduling). */
export const CADENCE_MS: Record<Cadence, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000,
};

/** Human label for a cadence (singular period noun). */
export const CADENCE_LABEL: Record<Cadence, string> = {
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
};

export function isCadence(v: unknown): v is Cadence {
  return v === "hourly" || v === "daily" || v === "weekly" || v === "monthly";
}

// ── Types ───────────────────────────────────────────────────────────────────

export type ContractStatus = "active" | "completed" | "cancelled";

export interface WorkContractRow {
  id: string;
  user_id: number;
  payee_address: string;
  payee_handle: string | null;
  title: string;
  rate_usd: number;
  cadence: Cadence;
  periods: number;
  stream_id: string;
  funding_digest: string | null;
  status: ContractStatus;
  created_at: number;
  updated_at: number;
}

/** A contract row merged with its live stream projection (progress figures). */
export interface ProjectedContract {
  id: string;
  payeeAddress: string;
  payeeHandle: string | null;
  title: string;
  rateUsd: number;
  cadence: Cadence;
  cadenceLabel: string;
  periods: number;
  totalUsd: number;
  streamId: string;
  fundingDigest: string | null;
  status: ContractStatus;
  createdAt: number;
  // Live stream-derived figures (null when the stream row is missing).
  paidUsd: number;
  remainingUsd: number;
  periodsPaid: number;
  nextPayAt: number | null;
  streamState: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function contractId(): string {
  return (
    "wc_" +
    Math.random().toString(36).slice(2, 8) +
    Math.random().toString(36).slice(2, 8)
  );
}

const MAX_TITLE = 120;

// ── Writes / reads ─────────────────────────────────────────────────────────

export async function createWorkContract(input: {
  userId: number;
  payeeAddress: string;
  payeeHandle?: string | null;
  title: string;
  rateUsd: number;
  cadence: Cadence;
  periods: number;
  streamId: string;
  fundingDigest?: string | null;
}): Promise<WorkContractRow> {
  await ensureWorkSchema();
  const id = contractId();
  const now = Date.now();
  const c = db();
  await c.execute({
    sql: `INSERT INTO work_contracts
            (id, user_id, payee_address, payee_handle, title, rate_usd,
             cadence, periods, stream_id, funding_digest, status,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    args: [
      id,
      input.userId,
      input.payeeAddress.toLowerCase(),
      input.payeeHandle?.trim() || null,
      input.title.trim().slice(0, MAX_TITLE),
      Math.round(input.rateUsd * 100) / 100,
      input.cadence,
      Math.floor(input.periods),
      input.streamId,
      input.fundingDigest ?? null,
      now,
      now,
    ],
  });
  const r = await c.execute({
    sql: "SELECT * FROM work_contracts WHERE id = ? LIMIT 1",
    args: [id],
  });
  return r.rows[0] as unknown as WorkContractRow;
}

export async function workContractById(
  id: string
): Promise<WorkContractRow | null> {
  await ensureWorkSchema();
  const r = await db().execute({
    sql: "SELECT * FROM work_contracts WHERE id = ? LIMIT 1",
    args: [id],
  });
  return (r.rows[0] as unknown as WorkContractRow) ?? null;
}

export async function workContractsFor(
  userId: number
): Promise<WorkContractRow[]> {
  await ensureWorkSchema();
  const r = await db().execute({
    sql: "SELECT * FROM work_contracts WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
    args: [userId],
  });
  return r.rows as unknown as WorkContractRow[];
}

/** Flip a contract's status (cancel / complete). */
export async function setContractStatus(
  id: string,
  status: ContractStatus
): Promise<void> {
  await ensureWorkSchema();
  await db().execute({
    sql: "UPDATE work_contracts SET status = ?, updated_at = ? WHERE id = ?",
    args: [status, Date.now(), id],
  });
}

/**
 * Merge a contract row with the live state of its underlying stream so the UI
 * gets one object with both the arrangement metadata AND the paid/remaining
 * progress. The stream is the source of truth for money moved; when its row is
 * missing (rare — e.g. a contract recorded before the stream insert landed) we
 * fall back to the contract's own static totals.
 */
export async function projectContract(
  row: WorkContractRow
): Promise<ProjectedContract> {
  const totalUsd = Math.round(row.rate_usd * row.periods * 100) / 100;
  let paidUsd = 0;
  let remainingUsd = totalUsd;
  let periodsPaid = 0;
  let nextPayAt: number | null = null;
  let streamState: string | null = null;

  try {
    const s = await streamById(row.stream_id);
    if (s) {
      const p = projectStream(s);
      paidUsd = p.releasedUsd;
      remainingUsd = p.remainingUsd;
      periodsPaid = p.tranchesDone;
      nextPayAt = p.nextTrancheAt;
      streamState = p.state;
    }
  } catch {
    /* stream read failed — fall back to static contract totals */
  }

  return {
    id: row.id,
    payeeAddress: row.payee_address,
    payeeHandle: row.payee_handle,
    title: row.title,
    rateUsd: Number(row.rate_usd),
    cadence: row.cadence,
    cadenceLabel: CADENCE_LABEL[row.cadence] ?? row.cadence,
    periods: Number(row.periods),
    totalUsd,
    streamId: row.stream_id,
    fundingDigest: row.funding_digest,
    status: row.status,
    createdAt: Number(row.created_at),
    paidUsd,
    remainingUsd,
    periodsPaid,
    nextPayAt,
    streamState,
  };
}
