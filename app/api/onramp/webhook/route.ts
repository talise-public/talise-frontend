import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";

/**
 * Stripe Crypto Onramp webhook.
 *
 * Stripe POSTs here when a session changes status. We verify the signature
 * using `STRIPE_WEBHOOK_SECRET` (set this in the Stripe dashboard at
 * Developers → Webhooks → Add endpoint, then subscribe to the
 * `crypto.onramp_session.updated` event).
 *
 * For now this only logs, the embedded SDK already signals success to
 * the client. Wire it to a DB action when we need durable receipts.
 *
 * Docs: https://docs.stripe.com/webhooks/signatures
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured, refuse to process. Failing closed is the
    // safest default; an attacker could otherwise POST anything to this
    // route and we'd "accept" it.
    return NextResponse.json(
      { error: "Webhook secret not configured." },
      { status: 503 }
    );
  }

  const signatureHeader = req.headers.get("stripe-signature");
  if (!signatureHeader) {
    return NextResponse.json(
      { error: "Missing Stripe-Signature header." },
      { status: 400 }
    );
  }

  // We need the raw body bytes to verify the signature, Next gives us the
  // already-decoded text via `req.text()` which is safe because we sign
  // the same string Stripe sent us.
  const rawBody = await req.text();

  // Stripe-Signature header looks like: `t=<timestamp>,v1=<signature>[,v0=…]`
  // (https://docs.stripe.com/webhooks/signatures#verify-manually)
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1 ? [kv, ""] : [kv.slice(0, idx), kv.slice(idx + 1)];
    })
  ) as Record<string, string>;

  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) {
    return NextResponse.json(
      { error: "Malformed Stripe-Signature header." },
      { status: 400 }
    );
  }

  const signedPayload = `${ts}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  // Constant-time compare so we don't leak the secret via timing.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid signature." },
      { status: 400 }
    );
  }

  // Optionally reject replays older than 5 minutes.
  const tsNum = Number(ts);
  if (Number.isFinite(tsNum)) {
    const ageSec = Math.floor(Date.now() / 1000) - tsNum;
    if (ageSec > 300) {
      return NextResponse.json(
        { error: "Webhook timestamp too old." },
        { status: 400 }
      );
    }
  }

  let event: { id?: string; type?: string; data?: { object?: unknown } } = {};
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  // For now: just log. Don't touch the DB, the embedded SDK already gives
  // us the success signal client-side. We can wire DB persistence here
  // later (e.g. mark an `onramp_receipts` row as fulfilled).
  console.log("[onramp/webhook]", {
    id: event.id,
    type: event.type,
  });

  return NextResponse.json({ received: true });
}
