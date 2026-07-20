import { db } from "@/lib/db";

/**
 * One Talise account to be indexed on-chain. `address` is the user's zkLogin
 * Sui address; `handle` is their `talise_username` (may be null).
 */
export type PagedUser = {
  userId: number;
  address: string;
  handle: string | null;
};

/**
 * Count Talise accounts that have a real on-chain address. Excludes soft-
 * deleted rows (markUserDeleted() redacts `sui_address` to a `deleted:%`
 * sentinel) so the analytics total reflects genuine, indexable accounts.
 *
 * Resilient: any DB failure returns 0 rather than throwing, analytics is a
 * read-only dashboard surface and must never break the page.
 */
export async function countUsers(): Promise<number> {
  try {
    const r = await db().execute({
      sql: `SELECT COUNT(*) AS n
              FROM users
             WHERE sui_address NOT LIKE 'deleted:%'`,
      args: [],
    });
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Page through the ordered user list for chunked, resumable indexing. Ordered
 * by `id ASC` so a cursor (offset) advances deterministically across many
 * batches. Excludes soft-deleted rows (mirrors countUsers()).
 *
 * Resilient: any DB failure returns [] so a single bad page just yields an
 * empty batch (the cursor stays put and retries next run).
 */
export async function listUsersPage(
  offset: number,
  limit: number
): Promise<PagedUser[]> {
  // Clamp to sane, non-negative integers, guards against a corrupted cursor
  // or a caller passing a float/negative.
  const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  const safeLimit = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0));
  if (safeLimit === 0) return [];

  try {
    const r = await db().execute({
      sql: `SELECT id, sui_address, talise_username
              FROM users
             WHERE sui_address NOT LIKE 'deleted:%'
             ORDER BY id ASC
             LIMIT ? OFFSET ?`,
      args: [safeLimit, safeOffset],
    });
    return r.rows.map((row) => ({
      userId: Number(row.id),
      address: String(row.sui_address),
      handle: (row.talise_username as string | null | undefined) ?? null,
    }));
  } catch {
    return [];
  }
}
