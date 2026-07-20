/**
 * Pure email-address helpers (no I/O).
 *
 * Apple "Hide My Email" (Sign in with Apple) hands us a relay address shaped
 * `abc123@privaterelay.appleid.com`. Bridge KYC can't verify a relay address,
 * so those users pile up as "Not started / Unknown" customers and can never
 * cash out. We detect the relay address and require a real email before KYC /
 * cash-out. (Apple offers "Hide My Email" whenever an app requests the email
 * scope and there is no way to disable it, so this is the only workable fix.)
 */

const APPLE_RELAY_SUFFIX = "@privaterelay.appleid.com";

/** True when `email` is an Apple private-relay ("Hide My Email") address. */
export function isPrivateRelayEmail(email: string | null | undefined): boolean {
  return (email ?? "").trim().toLowerCase().endsWith(APPLE_RELAY_SUFFIX);
}

/**
 * A usable real email for KYC: well-formed, not an Apple relay address, and not
 * an obvious placeholder. Deliberately permissive on shape (Bridge runs the
 * authoritative verification); the point is to keep relay/garbage addresses out
 * of the KYC path.
 */
export function isUsableRealEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || e.length > 254) return false;
  if (isPrivateRelayEmail(e)) return false;
  // local@domain.tld, no whitespace, a dotted domain with a 2+ char TLD.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}
