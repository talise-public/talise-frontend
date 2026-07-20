import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-auth";
import { runIndexBatch, type BatchResult } from "@/lib/analytics/reindex";

export const dynamic = "force-dynamic";

/**
 * POST /api/analytics/reindex, run a single on-chain index batch.
 *
 * Drives the resumable indexer one chunk forward: advances the cursor over the
 * ordered user list, walks each user's on-chain tx history, and persists the
 * results. Backs the admin "Index now" button. Returns the BatchResult so the
 * dashboard can show progress (processed / cursor / total / done). Admin-gated.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  try {
    const result: BatchResult = await runIndexBatch();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "failed to run index batch", detail: String(err) },
      { status: 500 }
    );
  }
}
