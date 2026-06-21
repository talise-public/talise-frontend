import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";

export const runtime = "nodejs";

/**
 * Stripe Crypto Onramp — server-side session creator (STANDALONE / hosted
 * URL flow). Sibling to `/api/onramp/session` (which returns
 * `client_secret` for the embedded JS SDK and is intentionally untouched).
 *
 * Why a separate route: Stripe's `/v1/crypto/onramp_sessions` endpoint
 * always returns BOTH `client_secret` (embedded mount) and `redirect_url`
 * (standalone hosted onramp at `crypto.link.com`). There is no
 * request-side flag to select between them — the integrator just picks
 * one. iOS has no first-party Stripe Crypto SDK, so we open the
 * `redirect_url` in `SFSafariViewController` and skip the embedded SDK
 * entirely. Keeping this in its own route means the existing embedded
 * web path's contract never moves and the iOS path gets a tightly typed
 * `{ redirectUrl, id }` response.
 *
 * The user's `sui_address` is forwarded as a locked destination wallet
 * so Stripe can only deliver USDC to that exact address. The
 * AutoConvertBanner on Home sweeps inbound USDC → USDsui automatically,
 * so the user's net effect is "buy USDsui with a card."
 *
 * Docs: https://docs.stripe.com/crypto/onramp/standalone-onramp-quickstart
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
  // for first-time onramp. Mirrors the embedded session route.
  let body: { amount?: number } = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as { amount?: number };
  } catch {
    // tolerate empty body
  }

  const rawAmount =
    typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount > 0
      ? body.amount
      : 100;
  // Soft-launch cap. iOS clamps to [1, 2_000]; we duplicate the ceiling
  // here so a tampered client can't request a $5k onramp that bounces
  // at Stripe KYC. Lift via env in week 2 once KYC pass-rate is measured.
  const amount = Math.min(2_000, Math.max(1, Math.round(rawAmount * 100) / 100));

  // Form-encoded body with bracketed keys for nested fields (Stripe REST).
  // Identical shape to the embedded route — we just consume `redirect_url`
  // instead of `client_secret` on the response.
  const form = new URLSearchParams();
  form.set("destination_currency", "usdc");
  form.set("destination_network", "sui");
  form.set("wallet_addresses[sui]", user.sui_address);
  form.set("lock_wallet_address", "true");
  form.set("source_currency", "usd");
  form.set("source_amount", String(amount));

  let resp: Response;
  try {
    resp = await fetch("https://api.stripe.com/v1/crypto/onramp_sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
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
    if (resp.status === 401) {
      return NextResponse.json(
        {
          error:
            "Stripe API key invalid. Check STRIPE_SECRET_KEY in .env.local.",
        },
        { status: 503 }
      );
    }
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
    if (resp.status >= 500) {
      return NextResponse.json(
        {
          error:
            rawMessage || `Stripe upstream failed (HTTP ${resp.status})`,
        },
        { status: 502 }
      );
    }
    const message =
      rawMessage || `Stripe request failed (HTTP ${resp.status})`;
    return NextResponse.json({ error: message }, { status: resp.status });
  }

  if (!json.redirect_url || !json.id) {
    return NextResponse.json(
      {
        error:
          "Stripe did not return a redirect_url. Check that Crypto Onramp is enabled on this account.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ redirectUrl: json.redirect_url, id: json.id });
}
