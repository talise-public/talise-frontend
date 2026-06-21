/**
 * The legacy `POST /api/waitlist` email-signup endpoint was RETIRED
 * (2026-06-07): it was an unauthenticated outbound-email-spam amplifier
 * (audit F9) and the live vector a datacenter IP used to flood
 * `waitlist_signups` with junk addresses. The product's real flow is
 * Google-first (sign in → /api/waitlist/handle/claim, email derived from
 * the session), so the endpoint now hard-returns 410 Gone on every method
 * — no body parse, no DB write, no email.
 *
 * These tests lock in that disabled contract so the endpoint can't be
 * silently re-opened without a failing test.
 */
import { describe, expect, it } from "vitest";

describe("legacy /api/waitlist is retired (410 Gone)", () => {
  it("POST → 410, no row, no email", async () => {
    const { POST } = await import("@/app/api/waitlist/route");
    const res = await POST();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/retired/i);
  });

  it("GET → 410", async () => {
    const { GET } = await import("@/app/api/waitlist/route");
    const res = await GET();
    expect(res.status).toBe(410);
  });

  it("PUT / PATCH / DELETE → 410", async () => {
    const mod = await import("@/app/api/waitlist/route");
    for (const m of [mod.PUT, mod.PATCH, mod.DELETE]) {
      const res = await m();
      expect(res.status).toBe(410);
    }
  });
});
