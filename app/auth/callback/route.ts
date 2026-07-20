import { NextResponse } from "next/server";
import { redirectUriFromRequest, verify } from "@/lib/auth";
import { clearStateCookie, readStateCookie, cookieDomain } from "@/lib/session";
import { completeSignIn } from "@/lib/auth-exchange";
import { issueMobileBearer, revokeAllMobileSessions } from "@/lib/mobile-sessions";
import { createAgentWallet, agentWalletsEnabled } from "@/lib/agent-wallets";

export const runtime = "nodejs";

/**
 * GET /auth/callback, Google's OAuth redirect target.
 *
 * Three flows split here, by the shape of the OAuth `state`:
 *
 *   • WEB (default): NO work on this request. Bounce instantly to /auth/finish,
 *     which POSTs code+state to /api/auth/exchange so the staged loader animates
 *     WHILE the real exchange runs. The exchange validates + consumes the state.
 *
 *   • MOBILE (`m1.` prefix, from /api/auth/mobile/start): single-request flow -
 *     ASWebAuthenticationSession needs a plain redirect to the `talise://` scheme,
 *     so we run the full exchange here and bounce with the bearer.
 *
 *   • CLI (`cli.<port>.<csrf>.…` prefix, from /api/auth/cli/start): same exchange
 *     as mobile, but redirect the bearer + the zkLogin binding (maxEpoch,
 *     randomness) to the CLI's loopback server on http://127.0.0.1:<port> so
 *     `talise login` can sign locally. The ephemeral private key never leaves the
 *     user's machine, only the maxEpoch/randomness it was bound to travel back.
 */
function redirectAuthError(req: Request, state: string | null, err: string): NextResponse {
  if (state && (state.startsWith("cli.") || state.startsWith("agw."))) {
    const parsed = parseLoopbackState(state);
    if (parsed) {
      const cb = new URL(`http://127.0.0.1:${parsed.port}/cb`);
      cb.searchParams.set("err", err);
      cb.searchParams.set("csrf", parsed.csrf);
      return NextResponse.redirect(cb.toString());
    }
  }
  if (state && state.startsWith("m1.")) {
    const callback = new URL("talise://auth/callback");
    callback.searchParams.set("err", err);
    return NextResponse.redirect(callback.toString());
  }
  return NextResponse.redirect(new URL(`/?err=${encodeURIComponent(err)}`, req.url));
}

/** Parse `<cli|agw>.<port>.<csrf>.<rand>`, port + csrf to build the loopback redirect. */
function parseLoopbackState(state: string): { port: number; csrf: string } | null {
  const parts = state.split(".");
  // [prefix, "<port>", "<csrf>", "<rand…>"], csrf + rand are dot-free base64url.
  if (parts.length < 4 || (parts[0] !== "cli" && parts[0] !== "agw")) return null;
  const port = Number(parts[1]);
  const csrf = parts[2] ?? "";
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(csrf)) return null;
  return { port, csrf };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    const safe = /^[a-z_]{1,40}$/.test(error) ? error : "oauth_error";
    return redirectAuthError(req, state, safe);
  }
  if (!code || !state) {
    return redirectAuthError(req, state, "missing_code");
  }

  // ── AGENT WALLET provisioning: complete sign-in, then create a custodial
  // agent wallet (server holds the ephemeral key) and hand the scoped token to
  // the loopback. Before the web branch for the same routing reason as CLI.
  if (state.startsWith("agw.")) {
    const parsed = parseLoopbackState(state);
    if (!parsed) return redirectAuthError(req, state, "bad_state");
    const done = await completeAgentProvision(req, state);
    if (!done.ok) return redirectAuthError(req, state, done.err);
    const cb = new URL(`http://127.0.0.1:${parsed.port}/cb`);
    cb.searchParams.set("agentToken", done.token);
    cb.searchParams.set("agentId", done.id);
    cb.searchParams.set("address", done.address);
    cb.searchParams.set("csrf", parsed.csrf);
    return NextResponse.redirect(cb.toString());
  }

  // ── CLI: run the full exchange, then redirect the bearer + binding to the
  // loopback server. Handled BEFORE the web branch because a `cli.` state does
  // not start with `m1.` and would otherwise be misrouted to /auth/finish.
  if (state.startsWith("cli.")) {
    const parsed = parseLoopbackState(state);
    if (!parsed) return redirectAuthError(req, state, "bad_state");
    // CLI path: do NOT revoke the user's other sessions, a `talise login`
    // must not sign the user out of their phone (or another CLI session).
    const done = await completeMobileExchange(req, state, { revokePrior: false });
    if (!done.ok) return redirectAuthError(req, state, done.err);
    const cb = new URL(`http://127.0.0.1:${parsed.port}/cb`);
    cb.searchParams.set("token", done.bearer);
    cb.searchParams.set("userId", String(done.userId));
    cb.searchParams.set("csrf", parsed.csrf);
    cb.searchParams.set("existing", done.isNew ? "0" : "1");
    // The CLI needs the exact binding it will sign against.
    if (done.maxEpoch != null) cb.searchParams.set("maxEpoch", String(done.maxEpoch));
    if (done.randomness) cb.searchParams.set("randomness", done.randomness);
    return NextResponse.redirect(cb.toString());
  }

  // ── WEB: hand off to the staged-loader page WITHOUT consuming the state
  // cookie, /api/auth/exchange validates + clears it.
  if (!state.startsWith("m1.")) {
    const finish = new URL("/auth/finish", req.url);
    finish.searchParams.set("code", code);
    finish.searchParams.set("state", state);
    return NextResponse.redirect(finish);
  }

  // ── MOBILE (`m1.`): full exchange, bounce to the app scheme.
  // Revoke the user's prior mobile sessions first so a fresh app sign-in
  // leaves exactly one selectable binding, this stops STALE rows (e.g. an
  // old ephemeral key with an already-expired max_epoch) from lingering and
  // being picked by the signer on the next deposit. CLI sessions are on their
  // own path and are intentionally spared (revokePrior:false above).
  const done = await completeMobileExchange(req, state, { revokePrior: true });
  if (!done.ok) return redirectAuthError(req, state, done.err);
  const callback = new URL("talise://auth/callback");
  callback.searchParams.set("token", done.bearer);
  callback.searchParams.set("userId", String(done.userId));
  callback.searchParams.set("existing", done.isNew ? "0" : "1");
  return NextResponse.redirect(callback.toString());
}

type ExchangeResult =
  | {
      ok: true;
      bearer: string;
      userId: number | string;
      isNew: boolean;
      maxEpoch: number | null;
      randomness: string | null;
    }
  | { ok: false; err: string };

/**
 * Shared mobile/CLI leg: validate the state cookie, read the (ephPubKey,
 * maxEpoch, randomness) binding stashed by the start route, complete the Google
 * sign-in, persist the signing material into `mobile_sessions`, and mint the
 * bearer. Returns the bearer + the binding the client must sign against.
 */
async function completeMobileExchange(
  req: Request,
  state: string,
  opts: { revokePrior?: boolean } = {}
): Promise<ExchangeResult> {
  const expected = await readStateCookie();
  if (!expected || expected !== state) {
    return { ok: false, err: "bad_state" };
  }
  await clearStateCookie();

  const url = new URL(req.url);
  const code = url.searchParams.get("code")!;

  const result = await completeSignIn({
    code,
    redirectUri: redirectUriFromRequest(req),
    country: req.headers.get("x-vercel-ip-country"),
  });
  if (!result.ok) return { ok: false, err: result.err };
  const { user, idToken, isNew } = result;

  // Read the (ephPubKey, maxEpoch, randomness) triple stashed by the start route
  // so future proof mints recompute the same Poseidon nonce the prover checks.
  const { cookies: cookieJar } = await import("next/headers");
  const { verify } = await import("@/lib/auth");
  const jar = await cookieJar();
  const bindingRaw = jar.get("talise_m1_binding")?.value;
  let bindingPubKey: string | null = null;
  let bindingMaxEpoch: number | null = null;
  let bindingRandomness: string | null = null;
  if (bindingRaw) {
    const verified = verify(bindingRaw);
    if (verified) {
      try {
        const decoded = JSON.parse(Buffer.from(verified, "base64url").toString("utf8"));
        bindingPubKey = decoded.ephemeralPubKey ?? null;
        bindingMaxEpoch = typeof decoded.maxEpoch === "number" ? decoded.maxEpoch : null;
        bindingRandomness = decoded.randomness ?? null;
      } catch {
        /* malformed, signing still works but a future send needs its own randomness */
      }
    }
  }
  // Clear with the SAME Domain/path the binding cookie was set with.
  jar.delete({ name: "talise_m1_binding", domain: cookieDomain(), path: "/" });

  // Fresh app sign-in: revoke the user's prior mobile_sessions rows BEFORE
  // inserting the new one, so only the current binding is selectable by the
  // signer. Prevents stale rows (old ephemeral key / expired max_epoch) from
  // shadowing the fresh binding on the next deposit. Gated to the mobile-app
  // path, CLI sign-in passes revokePrior:false to avoid logging the user out
  // of their phone or another CLI session.
  if (opts.revokePrior) {
    await revokeAllMobileSessions(user.id);
  }

  const bearer = await issueMobileBearer(user.id, {
    jwt: idToken,
    salt: user.salt,
    ephemeralPubKeyB64: bindingPubKey ?? undefined,
    maxEpoch: bindingMaxEpoch ?? undefined,
    randomness: bindingRandomness ?? undefined,
  });

  return {
    ok: true,
    bearer,
    userId: user.id,
    isNew,
    maxEpoch: bindingMaxEpoch,
    randomness: bindingRandomness,
  };
}

type ProvisionResult =
  | { ok: true; token: string; id: string; address: string }
  | { ok: false; err: string };

/**
 * Agent-wallet provisioning leg: validate state, read the signed binding cookie
 * (which carries the server-generated ephemeral SECRET + cap + name), complete
 * the Google sign-in, and persist a custodial agent wallet (secrets encrypted
 * at rest). Returns the one-time agent token for the loopback.
 */
async function completeAgentProvision(req: Request, state: string): Promise<ProvisionResult> {
  if (!agentWalletsEnabled()) return { ok: false, err: "agent_wallets_off" };

  const expected = await readStateCookie();
  if (!expected || expected !== state) return { ok: false, err: "bad_state" };
  await clearStateCookie();

  const { cookies: cookieJar } = await import("next/headers");
  const jar = await cookieJar();
  const bindingRaw = jar.get("talise_agw_binding")?.value;
  jar.delete({ name: "talise_agw_binding", domain: cookieDomain(), path: "/" });
  if (!bindingRaw) return { ok: false, err: "missing_binding" };
  const verified = verify(bindingRaw);
  if (!verified) return { ok: false, err: "bad_binding" };

  let b: {
    ephemeralPubKey?: string;
    ephemeralSecretB64?: string;
    maxEpoch?: number;
    randomness?: string;
    dailyCapUsd?: number;
    name?: string | null;
  };
  try {
    b = JSON.parse(Buffer.from(verified, "base64url").toString("utf8"));
  } catch {
    return { ok: false, err: "bad_binding" };
  }
  if (!b.ephemeralPubKey || !b.ephemeralSecretB64 || typeof b.maxEpoch !== "number" || !b.randomness || !b.dailyCapUsd) {
    return { ok: false, err: "bad_binding" };
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code")!;
  const result = await completeSignIn({
    code,
    redirectUri: redirectUriFromRequest(req),
    country: req.headers.get("x-vercel-ip-country"),
  });
  if (!result.ok) return { ok: false, err: result.err };
  const { user, idToken } = result;

  const { id, token } = await createAgentWallet({
    userId: Number(user.id),
    name: b.name ?? null,
    suiAddress: user.sui_address,
    jwt: idToken,
    salt: user.salt,
    ephemeralSkB64: b.ephemeralSecretB64,
    ephemeralPubKeyB64: b.ephemeralPubKey,
    maxEpoch: b.maxEpoch,
    randomness: b.randomness,
    dailyCapUsd: b.dailyCapUsd,
  });
  return { ok: true, token, id, address: user.sui_address };
}
