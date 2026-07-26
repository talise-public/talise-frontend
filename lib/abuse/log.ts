/**
 * Structured abuse logging — one stable prefix, one line per decision.
 *
 * Every rejection on the growth surface goes through here so abuse is
 * greppable in Vercel logs with a single query:
 *
 *   `[abuse]`                       → everything
 *   `[abuse] event=rate_limited`    → who is being throttled
 *   `[abuse] event=fail_closed`     → the limiter itself is degraded (paging-worthy)
 *   `[abuse] event=ip_denied`       → edge denylist hits
 *   `[abuse] event=datacenter`      → cloud/VPS traffic on the growth surface
 *   `[abuse] event=attest_*`        → device-attestation gate on the referral path
 *
 * Format is `key=value` pairs, not JSON: Vercel's log drain search is
 * substring-based, so `route=/api/referral/capture` is directly greppable
 * while a JSON blob is not. Values are sanitised (spaces → `_`) so a
 * forged header can't inject a fake field into the line.
 *
 * Edge-safe: console only, no imports.
 */

export type AbuseEvent =
  | "rate_limited"
  | "fail_closed"
  | "ip_denied"
  | "datacenter"
  | "attest_missing"
  | "attest_invalid"
  | "bad_cidr";

type Field = string | number | boolean | null | undefined;

/** Strip whitespace/newlines so untrusted values can't forge extra fields. */
function scrub(v: Field): string {
  const s = String(v ?? "");
  return s.replace(/[\s=]+/g, "_").slice(0, 120) || "-";
}

/**
 * Emit one abuse line. `fail_closed` is an ERROR (the limiter is degraded
 * and users are being turned away); everything else is a WARN (working as
 * designed, but we want it visible).
 */
export function abuseLog(event: AbuseEvent, fields: Record<string, Field>): void {
  const parts = [`[abuse]`, `event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${scrub(v)}`);
  }
  const line = parts.join(" ");
  if (event === "fail_closed") console.error(line);
  else console.warn(line);
}
