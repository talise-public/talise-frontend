import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { workInvoiceById } from "@/lib/invoices";
import { userById } from "@/lib/db";
import { InvoicePayView } from "@/components/app/work/InvoicePayView";

export const dynamic = "force-dynamic";

/**
 * PUBLIC invoice view + pay page, NOT under /app, so it renders standalone
 * without the AppShell chrome (no sidebar / nav). InvoicePayView applies the
 * light-mint skin (`landing-mint`) itself. Anyone with the link can view the
 * invoice and pay it; the "Pay this invoice" button routes into /app/pay
 * (which signs the payer in if needed).
 *
 * Server component: it reads the invoice + issuer directly (no public-API
 * round-trip), passes a public-safe subset to the client view. The customer
 * EMAIL is never sent to the client here.
 */

type RouteParams = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { id } = await params;
  const inv = await workInvoiceById(id).catch(() => null);
  if (!inv) return { title: "Invoice, Talise" };
  const title = `Invoice for $${inv.amountUsd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}, Talise`;
  return {
    title,
    description: inv.memo || "Pay this invoice with Talise, gasless digital dollars.",
    robots: { index: false, follow: false },
  };
}

export default async function PublicInvoicePage({ params }: RouteParams) {
  const { id } = await params;
  const invoice = await workInvoiceById(id);
  if (!invoice) notFound();

  const issuer = await userById(invoice.userId);
  if (!issuer) notFound();

  // Issuer identity renders as `name@talise` on the document (the .sui form
  // is reserved for SuiNS explanations, never the headline).
  const issuerHandle = issuer.talise_username
    ? `${issuer.talise_username}@talise`
    : issuer.suins_subname
      ? `${issuer.suins_subname.replace(/\.talise\.sui$/i, "")}@talise`
      : issuer.business_handle
        ? `${issuer.business_handle}@talise`
        : issuer.business_name || issuer.name || "A Talise user";

  // Resolve the absolute origin so the "open in app" links are absolute even
  // when NEXT_PUBLIC_BASE_URL isn't set in this environment.
  const h = await headers();
  const host = h.get("host") ?? "www.talise.io";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = (process.env.NEXT_PUBLIC_BASE_URL || `${proto}://${host}`).replace(/\/+$/, "");

  return (
    <InvoicePayView
      invoice={{
        id: invoice.id,
        amountUsd: invoice.amountUsd,
        currency: invoice.currency,
        customerName: invoice.customerName,
        lineItems: invoice.lineItems,
        memo: invoice.memo,
        status: invoice.status,
        dueMs: invoice.dueMs,
        createdAt: invoice.createdAt,
        payDigest: invoice.payDigest,
        paidAt: invoice.paidAt,
      }}
      issuer={{
        handle: issuerHandle,
        address: issuer.sui_address,
        name: issuer.business_name ?? issuer.name,
      }}
      origin={origin}
    />
  );
}
