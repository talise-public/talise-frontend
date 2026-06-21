/**
 * Origin for SHAREABLE links (pay links, invoices, cheques, referrals).
 *
 * The app lives on app.talise.io (gated), but the public receive surfaces
 * (/pay, /i, /c, /u) are canonically on www.talise.io — links you hand to
 * non-members shouldn't point at the gated subdomain, and the iOS scanner +
 * link previews treat www as canonical. Local dev / previews keep their own
 * origin so links stay testable.
 */
export function publicOrigin(): string {
  if (typeof window === "undefined") return "https://www.talise.io";
  const { protocol, host } = window.location;
  if (host === "app.talise.io") return "https://www.talise.io";
  return `${protocol}//${host}`;
}
