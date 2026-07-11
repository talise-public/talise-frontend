import { vi } from "vitest";

/**
 * Global setup for the Sui integration tests.
 *
 * The private-beta APP_ACCESS guard (`denyUnlessAppApproved`) was added to
 * every money API AFTER these tests were written, so unmocked it returns 403
 * and fails the send/swap/supply flows. These tests validate the transaction
 * LOGIC, not the beta gate (which has its own concern), so we treat the caller
 * as approved here. Applied globally via `setupFiles`.
 */
vi.mock("@/lib/app-access", () => ({
  denyUnlessAppApproved: vi.fn(async () => null),
  entryIsAppApproved: vi.fn(async () => true),
  appAccessDeniedResponse: () =>
    new Response(JSON.stringify({ code: "APP_ACCESS" }), { status: 403 }),
}));
