import "server-only";

import { db, ensureSchema } from "@/lib/db";

/**
 * Referral-loop instrumentation, the thin local helper.
 *
 * The referral loop was completely uninstrumented: `attributeReferral`
 * returned `{ok, reason}` and every caller threw it away, and nothing at all
 * recorded an invite being SENT or a `/r/CODE` link being CLICKED. K-factor
 * (invites sent per user × click-through × signup conversion) was therefore
 * uncomputable.
 *
 * This module is deliberately NOT a pipeline. A separate workstream owns the
 * `growth_events` table and a shared event emitter; this helper exists so the
 * referral surfaces can start emitting NOW and be re-pointed at that emitter
 * with a one-line change (swap the body of `emitGrowthEvent`).
 *
 * Two properties matter:
 *
 *  1. FEATURE DETECTION. `growth_events` may not exist yet, and when it lands
 *     we do not know its exact column names. We probe `information_schema`
 *     once per process, map our (name, user, metadata, timestamp) tuple onto
 *     whatever columns are actually there, and skip the insert entirely if the
 *     table is absent. A missing or differently-shaped table must never break
 *     sign-in.
 *  2. NEVER THROWS. Every path is wrapped. Emission is best-effort telemetry
 *     hanging off money-adjacent flows, it does not get a vote on whether a
 *     user can sign in.
 *
 * A structured console line is written on EVERY event regardless of the table,
 * so the funnel is derivable from logs even before `growth_events` exists.
 */

/** The referral funnel, in order. `invite_signup` is the conversion event. */
export type GrowthEventName =
  /** An invite link left the app (share sheet accepted, or link copied). */
  | "invite_sent"
  /** Someone opened `/r/<CODE>` (web landing or a claimed deep link). */
  | "invite_clicked"
  /** A first sign-in was successfully attributed to an inviter. */
  | "invite_signup"
  /** Attribution was attempted and refused, `reason` says why. */
  | "invite_attribution_failed";

export type GrowthEventFields = {
  /** The user the event is ABOUT (inviter for sent, referee for signup). */
  userId?: number | string | null;
  /** Referral code involved, uppercased 8-char code. */
  code?: string | null;
  /** Which client emitted it: "web" | "ios" | "android" | "server". */
  surface?: string | null;
  /** For `invite_attribution_failed`, the `attributeReferral` reason. */
  reason?: string | null;
  /** Free-form extras folded into the metadata column. */
  [key: string]: unknown;
};

/** Column candidates, first match wins. Ordered by how likely they are. */
const NAME_COLS = ["name", "event", "event_name", "kind", "type"];
const USER_COLS = ["user_id", "actor_user_id", "subject_user_id"];
const META_COLS = ["metadata", "meta", "props", "payload", "data", "properties"];
const TIME_COLS = ["created_at", "occurred_at", "ts", "inserted_at"];

type Shape = {
  present: boolean;
  nameCol: string | null;
  userCol: string | null;
  metaCol: string | null;
  timeCol: string | null;
  /** true when the timestamp column is an integer epoch (this repo's habit). */
  timeIsEpoch: boolean;
};

let shapeProbe: Promise<Shape> | null = null;

/**
 * One-shot probe of `growth_events`. Memoized on the module (per serverless
 * instance) because the answer only changes on deploy/migration, and a probe
 * per event would double the query cost of the whole funnel.
 *
 * A probe FAILURE is memoized as "absent" on purpose: if we cannot read
 * `information_schema` we must not retry on every event in a hot path.
 */
function probeShape(): Promise<Shape> {
  if (shapeProbe) return shapeProbe;
  const absent: Shape = {
    present: false,
    nameCol: null,
    userCol: null,
    metaCol: null,
    timeCol: null,
    timeIsEpoch: false,
  };
  shapeProbe = (async () => {
    try {
      await ensureSchema();
      const r = await db().execute({
        sql: `SELECT column_name, data_type
                FROM information_schema.columns
               WHERE table_name = 'growth_events'`,
        args: [],
      });
      if (!r.rows.length) return absent;
      const types = new Map<string, string>();
      for (const row of r.rows) {
        const col = String((row as Record<string, unknown>).column_name ?? "");
        const ty = String((row as Record<string, unknown>).data_type ?? "");
        if (col) types.set(col, ty.toLowerCase());
      }
      const pick = (cands: string[]) => cands.find((c) => types.has(c)) ?? null;
      const timeCol = pick(TIME_COLS);
      const timeType = timeCol ? (types.get(timeCol) ?? "") : "";
      const shape: Shape = {
        present: true,
        nameCol: pick(NAME_COLS),
        userCol: pick(USER_COLS),
        metaCol: pick(META_COLS),
        timeCol,
        timeIsEpoch: /int|numeric|decimal/.test(timeType),
      };
      // Without a name column we cannot say WHICH event this was, so the row
      // would be useless. Treat that as absent and stay on the log fallback.
      if (!shape.nameCol) return absent;
      return shape;
    } catch {
      return absent;
    }
  })();
  return shapeProbe;
}

/**
 * Record one funnel event. Always logs; additionally inserts into
 * `growth_events` once that table exists. Fire-and-forget: callers may
 * `void emitGrowthEvent(...)` without a catch.
 */
export async function emitGrowthEvent(
  name: GrowthEventName,
  fields: GrowthEventFields = {}
): Promise<void> {
  const { userId, ...rest } = fields;
  // Structured, greppable, and parseable without the table. This IS the
  // fallback pipeline, so keep the shape stable.
  try {
    console.log(
      `[growth] ${name} user=${userId ?? "-"} ${JSON.stringify(rest)}`
    );
  } catch {
    /* JSON.stringify on a cyclic extra, the insert below still runs */
  }

  try {
    const shape = await probeShape();
    if (!shape.present || !shape.nameCol) return;

    const cols: string[] = [shape.nameCol];
    const vals: unknown[] = [name];
    if (shape.userCol) {
      cols.push(shape.userCol);
      vals.push(userId == null ? null : Number(userId));
    }
    if (shape.metaCol) {
      cols.push(shape.metaCol);
      vals.push(JSON.stringify(rest));
    }
    if (shape.timeCol) {
      cols.push(shape.timeCol);
      vals.push(
        shape.timeIsEpoch ? Date.now() : new Date().toISOString()
      );
    }
    const placeholders = cols.map(() => "?").join(", ");
    await db().execute({
      sql: `INSERT INTO growth_events (${cols.join(", ")}) VALUES (${placeholders})`,
      args: vals as never[],
    });
  } catch (e) {
    // A shape mismatch (NOT NULL column we don't know about, enum that
    // rejects our name, …) must not surface. Log once per event and move on;
    // the console line above already carried the data.
    console.warn(`[growth] ${name} insert skipped: ${(e as Error).message}`);
  }
}
