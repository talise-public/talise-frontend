import "server-only";

import { randomUUID } from "node:crypto";
import { db, ensureSchema, schemaVersionGate } from "@/lib/db";

/**
 * Payout Teams, saved groups of recipients a user can re-pay in one tap.
 *
 * A team is just a named snapshot of recipient legs (handle/address + an
 * optional default amount + optional label). It carries NO money and is NEVER
 * trusted on the send path: when a team is loaded into the batch sheet the
 * recipients are re-resolved + re-screened by /api/payouts/batch/prepare like
 * any hand-typed recipient. This table is pure UI convenience.
 *
 * Schema is self-bootstrapping + memoized once-per-process, gated by a one-SELECT
 * schema-version check, mirroring lib/cheques.ts:ensureChequesSchema exactly.
 * Postgres DDL only.
 */

// ─── Schema ─────────────────────────────────────────────────────────────────

let _schemaReady: Promise<void> | null = null;
// Bump whenever ANY DDL below changes (mirrors the cheques/streams discipline).
const PAYOUT_TEAMS_SCHEMA_VERSION = "2026-06-25.1";

export function ensurePayoutTeamsSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate(
      "payout_teams_schema_version",
      PAYOUT_TEAMS_SCHEMA_VERSION
    );
    if (gate.upToDate) return;

    // One row per saved team. `members` is a JSON array of
    // {recipient, amount, label}, a display-only snapshot, re-resolved at pay
    // time. Names are unique per user so "Save as team" upserts by name.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS payout_teams (
        id         TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        name       TEXT NOT NULL,
        members    TEXT NOT NULL DEFAULT '[]',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    // On-chain teams: the `talise_payroll::payroll::Team` shared-object id this
    // roster mirrors. NULL for legacy DB-only teams (and whenever the on-chain
    // path is disabled). Display + index only, pay still re-resolves the
    // recipient strings in `members`.
    await c.execute(
      `ALTER TABLE payout_teams ADD COLUMN IF NOT EXISTS chain_object_id TEXT`
    );
    // Owner dashboard read (their teams, newest-touched first).
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_payout_teams_user ON payout_teams(user_id, updated_at DESC)`
    );
    // One team per (user, name), "Save as team" upserts by name via this index.
    await c.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_payout_teams_user_name ON payout_teams(user_id, name)`
    );

    await gate.stamp();
  })().catch((err) => {
    // Reset so a transient DDL error retries on the next call.
    _schemaReady = null;
    throw err;
  });
  return _schemaReady;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PayoutTeamMember {
  /** What the user typed: @handle / alice.talise.sui / 0x… */
  recipient: string;
  /** Optional default amount (USDsui). Editable before paying. */
  amount?: number;
  /** Optional per-recipient label (memo). */
  label?: string;
}

interface PayoutTeamRow {
  id: string;
  user_id: number;
  name: string;
  members: string;
  created_at: number;
  updated_at: number;
  chain_object_id: string | null;
}

export interface PayoutTeam {
  id: string;
  userId: number;
  name: string;
  members: PayoutTeamMember[];
  createdAt: number;
  updatedAt: number;
  /** On-chain Team object id, or null for DB-only teams. */
  chainObjectId: string | null;
}

const MAX_TEAMS_PER_USER = 50;
const MAX_MEMBERS = 50;
const MAX_NAME = 60;
const MAX_RECIPIENT = 200;
const MAX_LABEL = 120;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Parse a stored row into the UI-facing shape (tolerates a corrupt blob). */
function projectTeam(row: PayoutTeamRow): PayoutTeam {
  let members: PayoutTeamMember[] = [];
  try {
    const parsed = JSON.parse(row.members || "[]");
    if (Array.isArray(parsed)) members = parsed as PayoutTeamMember[];
  } catch {
    /* tolerate a corrupt blob, render an empty roster rather than 500 */
  }
  return {
    id: row.id,
    userId: Number(row.user_id),
    name: row.name,
    members,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    chainObjectId: row.chain_object_id ?? null,
  };
}

/**
 * Validate + clean an untrusted member array. Drops members with no recipient,
 * clamps text lengths, keeps a positive finite amount (else omits it), and caps
 * the roster size. Throws a friendly Error when the payload is unusable.
 */
export function sanitizeMembers(raw: unknown): PayoutTeamMember[] {
  if (!Array.isArray(raw)) {
    throw new Error("Team members must be a list.");
  }
  if (raw.length > MAX_MEMBERS) {
    throw new Error(`A team can have at most ${MAX_MEMBERS} members.`);
  }
  const out: PayoutTeamMember[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const recipient = String(obj.recipient ?? "").trim().slice(0, MAX_RECIPIENT);
    if (!recipient) continue;
    const member: PayoutTeamMember = { recipient };
    const amount = Number(obj.amount);
    if (Number.isFinite(amount) && amount > 0) {
      member.amount = Math.round(amount * 100) / 100;
    }
    const label = String(obj.label ?? "").trim().slice(0, MAX_LABEL);
    if (label) member.label = label;
    out.push(member);
  }
  if (out.length === 0) {
    throw new Error("A team needs at least one recipient.");
  }
  return out;
}

// ─── Reads / writes ─────────────────────────────────────────────────────────

export async function payoutTeamsFor(userId: number): Promise<PayoutTeam[]> {
  await ensurePayoutTeamsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM payout_teams WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200",
    args: [userId],
  });
  return (r.rows as unknown as PayoutTeamRow[]).map(projectTeam);
}

/** Look up one of the caller's teams by name (for the on-chain edit path -
 * an existing name with a `chainObjectId` means "edit", else "create"). */
export async function payoutTeamByName(
  userId: number,
  name: string
): Promise<PayoutTeam | null> {
  await ensurePayoutTeamsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM payout_teams WHERE user_id = ? AND name = ? LIMIT 1",
    args: [userId, name.trim().slice(0, MAX_NAME)],
  });
  const row = r.rows[0] as unknown as PayoutTeamRow | undefined;
  return row ? projectTeam(row) : null;
}

/** Look up one of the caller's teams by id (ownership enforced by user_id). */
export async function payoutTeamById(
  id: string,
  userId: number
): Promise<PayoutTeam | null> {
  await ensurePayoutTeamsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM payout_teams WHERE id = ? AND user_id = ? LIMIT 1",
    args: [id, userId],
  });
  const row = r.rows[0] as unknown as PayoutTeamRow | undefined;
  return row ? projectTeam(row) : null;
}

/**
 * Upsert a team by (user, name). A new name inserts; an existing name replaces
 * its members + bumps updated_at. Returns the saved team.
 */
export async function upsertPayoutTeam(input: {
  userId: number;
  name: string;
  members: PayoutTeamMember[];
  /** On-chain Team object id to record alongside the roster (optional). */
  chainObjectId?: string | null;
}): Promise<PayoutTeam> {
  await ensurePayoutTeamsSchema();
  const name = input.name.trim().slice(0, MAX_NAME);
  if (!name) throw new Error("A team needs a name.");
  const members = sanitizeMembers(input.members);
  const chainObjectId = input.chainObjectId ?? null;
  const now = Date.now();
  const c = db();

  // Cap total teams per user, only enforced on a genuinely NEW name.
  const existing = await c.execute({
    sql: "SELECT id FROM payout_teams WHERE user_id = ? AND name = ? LIMIT 1",
    args: [input.userId, name],
  });
  if (existing.rows.length === 0) {
    const count = await c.execute({
      sql: "SELECT COUNT(*) AS n FROM payout_teams WHERE user_id = ?",
      args: [input.userId],
    });
    const n = Number((count.rows[0] as { n: number | string } | undefined)?.n ?? 0);
    if (n >= MAX_TEAMS_PER_USER) {
      throw new Error(`You can save at most ${MAX_TEAMS_PER_USER} teams.`);
    }
  }

  const id = `pot_${randomUUID().replace(/-/g, "")}`;
  await c.execute({
    sql: `INSERT INTO payout_teams (id, user_id, name, members, created_at, updated_at, chain_object_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, name)
          DO UPDATE SET members = EXCLUDED.members,
                        updated_at = EXCLUDED.updated_at,
                        chain_object_id = COALESCE(EXCLUDED.chain_object_id, payout_teams.chain_object_id)`,
    args: [id, input.userId, name, JSON.stringify(members), now, now, chainObjectId],
  });

  const r = await c.execute({
    sql: "SELECT * FROM payout_teams WHERE user_id = ? AND name = ? LIMIT 1",
    args: [input.userId, name],
  });
  return projectTeam(r.rows[0] as unknown as PayoutTeamRow);
}

/** Delete a team (owner-only, the route enforces ownership via the WHERE clause). */
export async function deletePayoutTeam(id: string, userId: number): Promise<boolean> {
  await ensurePayoutTeamsSchema();
  const r = await db().execute({
    sql: "DELETE FROM payout_teams WHERE id = ? AND user_id = ?",
    args: [id, userId],
  });
  return (r.rowsAffected ?? 0) > 0;
}
