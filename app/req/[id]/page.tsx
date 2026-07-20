import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { previewRequest } from "@/lib/requests";
import { RequestPayView } from "./RequestPayView";

export const dynamic = "force-dynamic";

/**
 * PUBLIC payment-request view + pay page, NOT under /app, so it renders
 * standalone without the AppShell chrome (no sidebar / nav). RequestPayView
 * applies the light-mint skin itself. Anyone with the link can view the request
 * and pay it; the "Pay" button routes into /app/pay (which signs the payer in
 * if needed). No secret gate, a request, unlike a cheque, is open by design.
 *
 * Server component: it reads the request preview directly (no public-API
 * round-trip), which resolves the requester's display + pay address and
 * decrypts the optional Walrus note.
 */

type RouteParams = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { id } = await params;
  const preview = await previewRequest(id).catch(() => null);
  if (!preview) return { title: "Payment request, Talise" };
  const title = `${preview.requesterDisplay} requests $${preview.amountUsd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}, Talise`;
  return {
    title,
    description:
      preview.requesterNote || preview.note || "Pay this request with Talise, gasless digital dollars.",
    robots: { index: false, follow: false },
  };
}

export default async function PublicRequestPage({ params }: RouteParams) {
  const { id } = await params;
  const preview = await previewRequest(id);
  if (!preview) notFound();

  // Resolve the absolute origin so the QR + share links are absolute even when
  // NEXT_PUBLIC_BASE_URL isn't set in this environment.
  const h = await headers();
  const host = h.get("host") ?? "www.talise.io";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = (process.env.NEXT_PUBLIC_BASE_URL || `${proto}://${host}`).replace(/\/+$/, "");

  return (
    <RequestPayView
      request={{
        id: preview.id,
        amountUsd: preview.amountUsd,
        currency: preview.currency,
        requesterNote: preview.requesterNote,
        note: preview.note,
        status: preview.status,
        expiresAt: preview.expiresAt,
        createdAt: preview.createdAt,
        payDigest: preview.payDigest,
        paidAt: preview.paidAt,
      }}
      requester={{
        display: preview.requesterDisplay,
        address: preview.requesterAddress,
      }}
      origin={origin}
    />
  );
}
