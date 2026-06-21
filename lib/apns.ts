import "server-only";

import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";

/**
 * APNs (Apple Push Notification service) sender — token-based auth.
 *
 * ENV-GATED: with no Apple credentials in env, `sendApnsPush` cleanly no-ops
 * (returns `{ skipped: true }`) so the rest of the notify path runs unchanged.
 * To activate, set (the `.p8` key contents may use literal `\n` for newlines):
 *   APNS_KEY_P8   — the contents of the AuthKey_XXXX.p8 (PKCS#8 PEM)
 *   APNS_KEY_ID   — the 10-char Key ID for that key
 *   APNS_TEAM_ID  — your 10-char Apple Team ID
 *   APNS_BUNDLE_ID— the app bundle id / apns-topic (e.g. io.talise.app)
 *   APNS_ENV      — "production" (default) or "sandbox" (dev/TestFlight)
 */

type ApnsResult = {
  ok: boolean;
  status?: number;
  skipped?: boolean;
  reason?: string;
};

function creds() {
  const keyP8 = process.env.APNS_KEY_P8;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!keyP8 || !keyId || !teamId || !bundleId) return null;
  const host =
    (process.env.APNS_ENV ?? "production").toLowerCase() === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  return { keyP8, keyId, teamId, bundleId, host };
}

// APNs provider tokens are valid up to 1h; cache + refresh well inside that.
let _jwt: { token: string; atMs: number } | null = null;
const JWT_TTL_MS = 50 * 60 * 1000;

async function providerToken(
  c: NonNullable<ReturnType<typeof creds>>
): Promise<string> {
  if (_jwt && Date.now() - _jwt.atMs < JWT_TTL_MS) return _jwt.token;
  const key = await importPKCS8(c.keyP8.replace(/\\n/g, "\n"), "ES256");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: c.keyId })
    .setIssuer(c.teamId)
    .setIssuedAt()
    .sign(key);
  _jwt = { token, atMs: Date.now() };
  return token;
}

/**
 * Send a single alert push. Never throws — returns a result the caller logs.
 * `{ skipped: true }` means APNs isn't configured (the common dev/local case).
 */
export async function sendApnsPush(
  deviceToken: string,
  payload: {
    title: string;
    body: string;
    /** Optional bold second line under the title (above the body). */
    subtitle?: string;
    /** Groups related notifications into one stack in the shade. */
    threadId?: string;
    /** Registered category id (enables actions + a future Notification
     *  Content Extension to brand the expanded view). */
    category?: string;
    /** iOS 15+ delivery prominence. Money-in is "time-sensitive" so it
     *  surfaces promptly even in a Focus. */
    interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
    /** iOS 15+ ranking within the thread (0–1); 1 floats the latest
     *  credit to the top of the Talise stack. */
    relevanceScore?: number;
    /** App-icon badge count. */
    badge?: number;
    /** mutable-content:1 — lets a Notification Service Extension attach a
     *  branded image later without another server change. */
    mutableContent?: boolean;
    /** Absolute URL of a branded card image. Rides as the top-level
     *  `talise-image` key; the Notification Service Extension downloads it
     *  and attaches it so the expanded notification shows our theme.
     *  Requires `mutableContent: true` (set automatically when present). */
    imageUrl?: string;
    data?: Record<string, unknown>;
  }
): Promise<ApnsResult> {
  const c = creds();
  if (!c) return { ok: false, skipped: true, reason: "APNs not configured" };
  try {
    const jwt = await providerToken(c);
    const aps: Record<string, unknown> = {
      alert: {
        title: payload.title,
        ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
        body: payload.body,
      },
      sound: "default",
    };
    if (payload.threadId) aps["thread-id"] = payload.threadId;
    if (payload.category) aps.category = payload.category;
    if (payload.interruptionLevel) aps["interruption-level"] = payload.interruptionLevel;
    if (typeof payload.relevanceScore === "number")
      aps["relevance-score"] = payload.relevanceScore;
    if (typeof payload.badge === "number") aps.badge = payload.badge;
    // A branded image implies mutable-content: the NSE only runs when iOS
    // sees mutable-content:1, so force it on whenever an image is attached.
    if (payload.mutableContent || payload.imageUrl) aps["mutable-content"] = 1;
    const body = JSON.stringify({
      aps,
      ...(payload.imageUrl ? { "talise-image": payload.imageUrl } : {}),
      ...(payload.data ?? {}),
    });
    return await new Promise<ApnsResult>((resolve) => {
      const client = http2.connect(c.host);
      let settled = false;
      const done = (r: ApnsResult) => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          /* already closing */
        }
        resolve(r);
      };
      client.on("error", (e) => done({ ok: false, reason: (e as Error).message }));
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": c.bundleId,
        "apns-push-type": "alert",
        "content-type": "application/json",
      });
      let status = 0;
      let resBody = "";
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.on("data", (d) => {
        resBody += d;
      });
      req.on("end", () =>
        done({
          ok: status === 200,
          status,
          reason: status === 200 ? undefined : resBody.slice(0, 200),
        })
      );
      req.on("error", (e) => done({ ok: false, reason: (e as Error).message }));
      req.write(body);
      req.end();
    });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
