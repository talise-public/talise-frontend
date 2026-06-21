/**
 * Regression guard for the bug "refreshing the app breaks / shrinks the
 * Recent history". On-chain history is IMMUTABLE, so /api/activity must treat
 * its per-user snapshot as a MONOTONIC FLOOR: a transient empty/partial chain
 * scan can only ADD rows, never delete them. These tests mock the chain scan +
 * snapshot store so they run fast and offline (no mainnet).
 *
 * See web/lib/activity-snapshot.ts (`mergeMonotonic` / `computeLiveActivity`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable chain scan + an in-memory snapshot row.
const { getRecentActivityMock } = vi.hoisted(() => ({
  getRecentActivityMock: vi.fn(),
}));
const { snapStore } = vi.hoisted(() => ({
  snapStore: { current: null as null | Record<string, unknown> },
}));

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 1),
}));
vi.mock("@/lib/db", () => ({
  userById: vi.fn(async () => ({
    id: 1,
    sui_address: "0xabc",
    talise_vault_id: null,
  })),
}));
vi.mock("@/lib/activity", () => ({ getRecentActivity: getRecentActivityMock }));
// The ?fresh=1 path doesn't touch memoTtl, but the route imports it — passthrough.
vi.mock("@/lib/perf-cache", () => ({
  memoTtl: (_k: string, _t: number, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/snapshots", () => ({
  readActivitySnapshot: vi.fn(async () => snapStore.current),
  writeActivitySnapshot: vi.fn(async (s: { userId: number; address: string; entries: unknown[]; source?: string }) => {
    snapStore.current = {
      userId: s.userId,
      address: s.address,
      entries: s.entries,
      source: s.source ?? "chain",
      refreshedAt: Date.now(),
    };
  }),
  refreshInBackground: vi.fn(),
}));

const { GET } = await import("@/app/api/activity/route");

type Row = { digest: string; timestampMs: number };
function entry(digest: string, timestampMs: number) {
  return {
    digest,
    timestampMs,
    direction: "received",
    amountUsdsui: 1,
    amountSui: null,
    counterparty: null,
    counterpartyName: null,
    venue: null,
    roundupUsdsui: null,
    otherCoin: null,
  };
}
function seedSnapshot(rows: ReturnType<typeof entry>[]) {
  snapStore.current = {
    userId: 1,
    address: "0xabc",
    entries: rows,
    source: "chain",
    refreshedAt: Date.now(),
  };
}
// ?fresh=1 bypasses the snapshot-serve shortcut so computeLiveActivity (and the
// merge) actually runs — that's the reconcile path the optimistic-send flow uses.
function freshReq() {
  return new Request("http://localhost/api/activity?limit=20&fresh=1", {
    headers: { authorization: "Bearer x" },
  });
}
async function digestsOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { entries: Row[] };
  return body.entries.map((e) => e.digest);
}

describe("/api/activity — monotonic snapshot floor", () => {
  beforeEach(() => {
    snapStore.current = null;
    vi.clearAllMocks();
  });

  it("a transient empty chain scan does NOT shrink existing history", async () => {
    seedSnapshot([entry("A", 300), entry("B", 200), entry("C", 100)]);
    getRecentActivityMock.mockResolvedValue([]); // chain read failed → []
    const res = await GET(freshReq());
    expect(await digestsOf(res)).toEqual(["A", "B", "C"]);
  });

  it("a newly-landed tx is unioned with the snapshot, newest-first", async () => {
    seedSnapshot([entry("A", 200), entry("B", 100)]);
    getRecentActivityMock.mockResolvedValue([entry("C", 300)]); // the new tx
    const res = await GET(freshReq());
    expect(await digestsOf(res)).toEqual(["C", "A", "B"]);
    // The union is persisted back as the new floor.
    expect((snapStore.current?.entries as Row[]).map((e) => e.digest)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("a partial chain scan never drops a previously-seen row", async () => {
    seedSnapshot([entry("A", 200), entry("B", 100)]);
    getRecentActivityMock.mockResolvedValue([entry("A", 200)]); // only A this round
    const res = await GET(freshReq());
    expect((await digestsOf(res)).sort()).toEqual(["A", "B"]); // B preserved
  });

  it("first-ever load with no snapshot returns the live rows", async () => {
    snapStore.current = null;
    getRecentActivityMock.mockResolvedValue([entry("A", 200), entry("B", 100)]);
    const res = await GET(freshReq());
    expect(await digestsOf(res)).toEqual(["A", "B"]);
  });
});
