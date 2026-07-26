import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { REFERRAL_CODE_RE } from "@/lib/db";

export const metadata: Metadata = {
  title: "Talise",
};

/**
 * The waitlist is locked. This route is intentionally unreachable: it renders
 * the global 404 page (app/not-found.tsx). New sign-ups are closed; users are
 * routed to the iOS beta instead.
 *
 * ONE exception, and the reason this file is not just `notFound()`: there were
 * two competing referral loops sharing one counter. The app loop is
 * `/r/<CODE>`; a second loop handed out `/waitlist?ref=<CODE>` links (from the
 * waitlist dashboard and every public `/u/<handle>` profile). Those links are
 * already in the wild, in DMs and screenshots, and since the waitlist locked
 * they have all landed on a 404, losing both the visitor and the attribution.
 *
 * So: a `?ref=` on this path is treated as what it is, an invite, and forwarded
 * to the canonical entry point, which sets the signed referral cookie and sends
 * the visitor to the landing page. Everything else still 404s, the waitlist
 * stays closed. Both link generators now emit `/r/<CODE>` directly, so this is
 * purely a compatibility shim for links already shared.
 */
export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[] }>;
}) {
  const { ref } = await searchParams;
  const raw = Array.isArray(ref) ? ref[0] : ref;
  const code = (raw ?? "").trim().toUpperCase();
  if (REFERRAL_CODE_RE.test(code)) redirect(`/r/${code}`);
  notFound();
}
