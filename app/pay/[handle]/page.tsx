import type { Metadata } from "next";
import { PublicPay } from "@/components/app/pay/PublicPay";

/**
 * /pay/<handle>, the PUBLIC, ungated payment page.
 *
 * The shareable target of a Talise payment link. It deliberately does NOT
 * resolve the recipient server-side (the resolve endpoint is authed and we
 * don't leak the handle table to crawlers). It renders the handle + optional
 * amount/memo from the URL and routes the visitor into the in-app send flow
 * with the recipient prefilled, sign-in is handled there.
 *
 * In Next 15, `params` and `searchParams` are async.
 */

type Params = { handle: string };
type Search = { amount?: string; memo?: string };

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 1_000_000_000) return null;
  return Math.round(v * 100) / 100;
}

function decodeSlug(handle: string): string {
  try {
    return decodeURIComponent(handle).replace(/^@/, "").trim();
  } catch {
    return handle.replace(/^@/, "").trim();
  }
}

function prettyName(slug: string): string {
  return /^0x[0-9a-fA-F]{6,}$/.test(slug) ? `${slug.slice(0, 8)}…${slug.slice(-6)}` : `@${slug}`;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const { handle } = await params;
  const { amount } = await searchParams;
  const slug = decodeSlug(handle);
  const amt = parseAmount(amount);
  const name = prettyName(slug);
  const title = amt != null ? `Pay ${name} $${amt.toFixed(2)} · Talise` : `Pay ${name} · Talise`;
  const description =
    "Pay on Talise, a gasless dollar wallet on Sui. Settles in seconds, no gas, no seed phrase.";
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicPayPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { handle } = await params;
  const { amount, memo } = await searchParams;
  const slug = decodeSlug(handle);
  const amountUsd = parseAmount(amount);
  const cleanMemo = memo ? memo.toString().slice(0, 120) : null;

  return <PublicPay slug={slug} amountUsd={amountUsd} memo={cleanMemo} />;
}
