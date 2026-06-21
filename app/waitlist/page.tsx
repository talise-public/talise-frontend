import { notFound } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Talise",
};

/**
 * The waitlist is locked. This route is intentionally unreachable: it renders
 * the global 404 page (app/not-found.tsx). New sign-ups are closed; users are
 * routed to the iOS beta instead.
 */
export default function WaitlistPage(): never {
  notFound();
}
