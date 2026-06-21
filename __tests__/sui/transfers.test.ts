import { describe, it, expect } from "vitest";
import {
  allowedEvents,
  isPastCommit,
  TERMINAL_STATES,
  COMMIT_STATE,
  type TransferState,
} from "@/lib/transfers";

describe("transfers state machine", () => {
  it("walks the happy path forward, one legal event per step", () => {
    expect(allowedEvents("quoted")).toContain("debit");
    expect(allowedEvents("debited")).toContain("start_onchain");
    expect(allowedEvents("onchain_settling")).toContain("confirm_onchain");
    expect(allowedEvents("onchain_settled")).toContain("start_fiat_out");
    expect(allowedEvents("fiat_out_pending")).toContain("confirm_fiat_out");
  });

  it("commit point is onchain_settled; isPastCommit flips there", () => {
    expect(COMMIT_STATE).toBe("onchain_settled");
    expect(isPastCommit("quoted")).toBe(false);
    expect(isPastCommit("debited")).toBe(false);
    expect(isPastCommit("onchain_settling")).toBe(false);
    expect(isPastCommit("onchain_settled")).toBe(true);
    expect(isPastCommit("fiat_out_pending")).toBe(true);
    // Terminal states are not "in-flight past commit".
    expect(isPastCommit("settled")).toBe(false);
    expect(isPastCommit("refunded")).toBe(false);
  });

  it("pre-commit states can abort cleanly; post-commit cannot abort (only fail/park)", () => {
    expect(allowedEvents("quoted")).toContain("abort");
    expect(allowedEvents("debited")).toContain("abort");
    expect(allowedEvents("onchain_settling")).toContain("abort");
    // No clean abort once value crossed the boundary.
    expect(allowedEvents("onchain_settled")).not.toContain("abort");
    expect(allowedEvents("fiat_out_pending")).not.toContain("abort");
    // …but they can still fail (which parks the funds).
    expect(allowedEvents("onchain_settled")).toContain("fail");
    expect(allowedEvents("fiat_out_pending")).toContain("fail");
  });

  it("a parked failure can be reconciled into a refund (compensation path is live)", () => {
    // This is the path the advanceTransfer terminal-guard carve-out keeps
    // open: failed -> refund -> refunded.
    expect(allowedEvents("failed")).toContain("refund");
  });

  it("truly-terminal success/refunded states have no outgoing events", () => {
    expect(allowedEvents("settled")).toHaveLength(0);
    expect(allowedEvents("refunded")).toHaveLength(0);
    expect(TERMINAL_STATES.has("settled")).toBe(true);
    expect(TERMINAL_STATES.has("refunded")).toBe(true);
  });

  it("no event resurrects a settled transfer", () => {
    const all: TransferState[] = [
      "quoted", "debited", "onchain_settling", "onchain_settled",
      "fiat_out_pending", "settled", "failed", "refunded",
    ];
    // Only `failed` among terminal states exposes an event (refund).
    for (const s of all) {
      if (s === "settled" || s === "refunded") {
        expect(allowedEvents(s)).toHaveLength(0);
      }
    }
  });
});
