/**
 * Invite share copy, the single source of truth for all three clients.
 *
 * Before this module there were three DIFFERENT hardcoded strings (web
 * ReferralCard, iOS RewardsView, Android RewardsScreen), so an invite read
 * differently depending on which app your friend happened to be holding.
 *
 * Web imports these constants directly. iOS and Android cannot import TS, so
 * `/api/referral/summary` serves the resolved strings back in a `share` block
 * and the native clients render THAT, keeping a local constant only as an
 * offline fallback. Change the copy here and every surface follows.
 *
 * Copy rules baked in here (do not regress them):
 *   - a send finalizes "in under a second", never "in seconds"
 *   - no em-dashes
 *   - no privacy or yield claims
 */

/** Canonical host for links handed to people who are not members yet. */
const CANONICAL_ORIGIN = "https://www.talise.io";

/** Share-sheet title (used where a platform separates title from body). */
export const INVITE_SHARE_TITLE = "Talise";

/**
 * The invite sentence. Deliberately concrete about the one thing that is
 * demonstrably true and worth sharing: dollars, anywhere, settled fast.
 */
export const INVITE_SHARE_TEXT =
  "Join me on Talise. Send dollars to anyone, anywhere, and it finalizes in under a second.";

/** The one canonical referral entry point: /r/<CODE>. */
export function inviteUrl(code: string, origin: string = CANONICAL_ORIGIN): string {
  return `${origin.replace(/\/$/, "")}/r/${code.trim().toUpperCase()}`;
}

/** Text + link, the payload handed to a share sheet or clipboard. */
export function inviteShareMessage(
  code: string,
  origin: string = CANONICAL_ORIGIN
): string {
  return `${INVITE_SHARE_TEXT} ${inviteUrl(code, origin)}`;
}

/**
 * The `share` block `/api/referral/summary` returns to native clients. Keep
 * the field names stable, iOS/Android decode them.
 */
export function inviteSharePayload(code: string): {
  title: string;
  text: string;
  url: string;
  message: string;
} {
  return {
    title: INVITE_SHARE_TITLE,
    text: INVITE_SHARE_TEXT,
    url: inviteUrl(code),
    message: inviteShareMessage(code),
  };
}
