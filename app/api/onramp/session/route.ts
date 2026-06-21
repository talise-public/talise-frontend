import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";

export const runtime = "nodejs";

/**
 * Stripe Crypto Onramp — server-side session creator (embedded SDK flow).
 *
 * Returns `{ clientSecret, id }` instead of `redirect_url` so the client can
 * mount the embedded Onramp UI via `@stripe/crypto` and keep the user on
 * our domain. The user's `sui_address` is forwarded as a locked destination
 * wallet so Stripe can only deliver to that exact address. The user's net
 * effect is "buy USDsui with a card" because the home page's
 * AutoConvertBanner sweeps any inbound USDC to USDsui automatically.
 *
 * We use `fetch` directly against Stripe's REST API to avoid pulling in the
 * `stripe` npm package — keeps the dependency footprint small and the
 * surface area minimal (one call, one shape).
 *
 * Docs: https://docs.stripe.com/crypto/onramp
 */
export async function POST(req: Request) {
  // P1-5: mobile traffic must carry an App Attest assertion.
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      { error: "Stripe is not configured on this server." },
      { status: 500 }
    );
  }

  // Optional `{ amount }` override. Default to $20 — Stripe's sweet spot
  // for first-time onramp.
  let body: { amount?: number } = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as { amount?: number };
  } catch {
    // tolerate empty body
  }

  const amount =
    typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount > 0
      ? Math.round(body.amount * 100) / 100
      : 20;

  // Form-encoded body with bracketed keys for nested fields (Stripe REST).
  const form = new URLSearchParams();
  form.set("destination_currency", "usdc");
  form.set("destination_network", "sui");
  form.set("wallet_addresses[sui]", user.sui_address);
  form.set("lock_wallet_address", "true");
  form.set("source_currency", "usd");
  form.set("source_amount", String(amount));
  // No success_url / cancel_url — the embedded SDK signals completion via
  // event callbacks in the browser, not via redirect.

  let resp: Response;
  try {
    resp = await fetch("https://api.stripe.com/v1/crypto/onramp_sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      // Hard deadline — Stripe is normally <1s but we never want a hung
      // socket to hold a serverless function open.
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: `Could not reach Stripe: ${(e as Error).message ?? "unknown"}`,
      },
      { status: 502 }
    );
  }

  const json = (await resp.json().catch(() => ({}))) as {
    id?: string;
    client_secret?: string;
    redirect_url?: string;
    error?: { message?: string; code?: string; type?: string };
  };

  if (!resp.ok) {
    const rawMessage = json.error?.message ?? "";
    // 401 — bad / missing key.
    if (resp.status === 401) {
      return NextResponse.json(
        {
          error:
            "Stripe API key invalid. Check STRIPE_SECRET_KEY in .env.local.",
        },
        { status: 503 }
      );
    }
    // 400 with the dashboard-must-enable-crypto hint.
    if (
      resp.status === 400 &&
      /crypto.*(must be enabled|not enabled|enable)/i.test(rawMessage)
    ) {
      return NextResponse.json(
        {
          error:
            "Crypto Onramp isn't enabled on this Stripe account. Open the Stripe dashboard → Crypto → Get started and enable it, then retry.",
        },
        { status: 503 }
      );
    }
    // Generic 5xx — bubble Stripe's own message, mapped to 502 upstream.
    if (resp.status >= 500) {
      return NextResponse.json(
        {
          error:
            rawMessage || `Stripe upstream failed (HTTP ${resp.status})`,
        },
        { status: 502 }
      );
    }
    // All other Stripe errors — forward status + message.
    const message =
      rawMessage || `Stripe request failed (HTTP ${resp.status})`;
    return NextResponse.json({ error: message }, { status: resp.status });
  }

  if (!json.client_secret || !json.id) {
    return NextResponse.json(
      {
        error:
          "Stripe did not return a client_secret. This usually means the embedded Onramp SDK isn't enabled for this account — check your Stripe dashboard.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ clientSecret: json.client_secret, id: json.id });
}
