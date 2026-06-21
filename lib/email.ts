import { Resend } from "resend";
import { render } from "@react-email/render";
import {
  welcomeWithAddressHtml,
  welcomeEmailOnlyHtml,
  type WelcomeData,
} from "./emails/welcome";
import { WaitlistConfirmation } from "../emails/WaitlistConfirmation";

let _resend: Resend | null = null;

function client(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

function from(): string {
  return process.env.EMAIL_FROM || "Talise <onboarding@resend.dev>";
}

type SendResult = { ok: true; id: string } | { ok: false; reason: string };

async function send(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<SendResult> {
  const r = client();
  if (!r) {
    // Dev mode without Resend key — log and pretend success.
    console.log(
      `[email/dev] would send to=${opts.to} subject="${opts.subject}" (${opts.html.length} bytes)`
    );
    return { ok: true, id: "dev-noop" };
  }
  try {
    const res = await r.emails.send({
      from: from(),
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      replyTo: process.env.WAITLIST_REPLY_TO || process.env.EMAIL_REPLY_TO,
    });
    if (res.error) return { ok: false, reason: res.error.message };
    if (!res.data?.id) return { ok: false, reason: "no email id returned" };
    return { ok: true, id: res.data.id };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function sendWelcomeWithAddress(
  to: string,
  data: WelcomeData
): Promise<SendResult> {
  return send({
    to,
    subject: "You're in. Your Sui address is ready.",
    html: welcomeWithAddressHtml(data),
  });
}

export async function sendWelcomeEmailOnly(
  to: string,
  position: number
): Promise<SendResult> {
  return send({
    to,
    subject: "You're on the Talise waitlist.",
    html: welcomeEmailOnlyHtml(position),
  });
}

/**
 * Notify a recipient that money just landed in their Talise balance.
 * Fired (fire-and-forget) from the settlement path once a transfer confirms.
 */
export async function sendInboundReceivedEmail(opts: {
  to: string;
  amountUsd: number;
  senderName: string;
}): Promise<SendResult> {
  // "Open Talise" deep-links into the iOS app via its registered URL scheme
  // (CFBundleURLSchemes: "talise"), so tapping it on a phone opens the app
  // rather than a web page. Recipients are Talise users (the app is installed).
  const openApp = "talise://";
  const amount = `$${opts.amountUsd.toFixed(2)}`;
  const safeSender = opts.senderName.replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c
  );
  const html = `<!doctype html><html><body style="margin:0;background:#0b0f0a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;background:#11160f;border:1px solid #1f2a18;border-radius:18px;padding:32px">
      <tr><td style="padding-bottom:22px"><img src="https://app.talise.io/email-logo.png" width="40" height="37" alt="Talise" style="display:block;border:0;outline:none"></td></tr>
      <tr><td style="font-size:13px;letter-spacing:.12em;color:#7fae5f;text-transform:uppercase">Talise</td></tr>
      <tr><td style="padding-top:14px;font-size:28px;font-weight:600;color:#caffb8">💰 ${amount} received</td></tr>
      <tr><td style="padding-top:10px;font-size:15px;line-height:1.55;color:#a9c79a">${safeSender} sent you ${amount}. It's already in your Talise balance. Hold it in dollars, send it onward, or put it to work.</td></tr>
      <tr><td style="padding-top:24px"><a href="${openApp}" style="display:inline-block;background:#caffb8;color:#0b0f0a;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">Open Talise</a></td></tr>
    </table>
  </td></tr></table>
  </body></html>`;
  return send({ to: opts.to, subject: `💰 You received ${amount} on Talise`, html });
}

/**
 * A waitlist-confirmation email rendered to its final wire form (HTML +
 * subject + recipient) but NOT yet handed to Resend. Produced by
 * `prerenderWaitlistConfirmation` so the (side-effect-free, ~ms-to-tens-
 * of-ms) React-Email render can run CONCURRENTLY with slow work on the
 * caller's critical path (e.g. the on-chain mint), leaving only the
 * Resend API call to fire afterwards via `sendPrerenderedWaitlistConfirmation`.
 */
export type PreparedWaitlistConfirmation = {
  to: string;
  subject: string;
  html: string;
};

/**
 * Render a waitlist confirmation to HTML + subject WITHOUT sending it.
 * Pure (no network, no side effects) — safe to kick off and `await`
 * later, or to race against other in-flight work. Pulls `appUrl` and the
 * handle-aware subject exactly as the combined send path did.
 */
export async function prerenderWaitlistConfirmation(opts: {
  to: string;
  name?: string | null;
  /**
   * Bare handle (no `@`, no `.talise.sui`) the user just claimed.
   * When set, the email renders a "your reserved handle" pill and the
   * subject swaps to a handle-aware variant.
   */
  claimedHandle?: string | null;
}): Promise<PreparedWaitlistConfirmation> {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "https://talise.io";

  const html = await render(
    WaitlistConfirmation({
      name: opts.name ?? null,
      appUrl,
      claimedHandle: opts.claimedHandle ?? null,
    })
  );

  const subject = opts.claimedHandle
    ? `${opts.claimedHandle}@talise.sui is yours.`
    : "You are on the Talise waitlist.";

  return { to: opts.to, subject, html };
}

/**
 * Send a pre-rendered waitlist confirmation via Resend. This is the only
 * step that touches the network, so it is the only thing that needs to
 * sit on the post-mint critical path. `from` comes from
 * WAITLIST_FROM_EMAIL (must be a Resend-verified talise.io sender) and
 * ops are optionally BCC'd via WAITLIST_BCC_EMAIL.
 *
 * Returns the Resend message id on success so the caller can persist it
 * for traceability.
 */
export async function sendPrerenderedWaitlistConfirmation(
  prepared: PreparedWaitlistConfirmation
): Promise<SendResult> {
  const { to, subject, html } = prepared;

  const fromAddr =
    process.env.WAITLIST_FROM_EMAIL || "Talise <waitlist@talise.io>";
  const bcc = process.env.WAITLIST_BCC_EMAIL?.trim();
  const replyTo =
    process.env.WAITLIST_REPLY_TO || process.env.EMAIL_REPLY_TO || undefined;

  const r = client();
  if (!r) {
    // In production, NOT having a Resend key is a hard misconfig — the
    // user signed up expecting a confirmation. Refusing here surfaces it
    // (route logs "send failed: RESEND_API_KEY missing") instead of
    // silently marking `confirmation_sent=true` on a no-op.
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "RESEND_API_KEY missing in production" };
    }
    console.log(
      `[email/dev] would send waitlist confirmation to=${to} (${html.length} bytes)`
    );
    return { ok: true, id: "dev-noop" };
  }
  try {
    const payload: Parameters<typeof r.emails.send>[0] = {
      from: fromAddr,
      to: [to],
      subject,
      html,
      ...(bcc ? { bcc: [bcc] } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
    const res = await r.emails.send(payload);
    if (res.error) {
      console.warn(
        `[email/waitlist-send] FAILED to=${to} from="${fromAddr}" bcc=${bcc ?? "—"} error=${res.error.message}`
      );
      return { ok: false, reason: res.error.message };
    }
    if (!res.data?.id) {
      console.warn(
        `[email/waitlist-send] no id returned to=${to} from="${fromAddr}" bcc=${bcc ?? "—"}`
      );
      return { ok: false, reason: "no email id returned" };
    }
    console.log(
      `[email/waitlist-send] OK to=${to} from="${fromAddr}" bcc=${bcc ?? "—"} resendId=${res.data.id}`
    );
    return { ok: true, id: res.data.id };
  } catch (err) {
    console.warn(
      `[email/waitlist-send] EXCEPTION to=${to} from="${fromAddr}" bcc=${bcc ?? "—"} err=${(err as Error).message}`
    );
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Render-and-send a waitlist confirmation in one call. Kept for callers
 * that don't need to overlap the render with other work. Equivalent to
 * `sendPrerenderedWaitlistConfirmation(await prerenderWaitlistConfirmation(opts))`.
 */
export async function sendWaitlistConfirmation(opts: {
  to: string;
  name?: string | null;
  claimedHandle?: string | null;
}): Promise<SendResult> {
  const prepared = await prerenderWaitlistConfirmation(opts);
  return sendPrerenderedWaitlistConfirmation(prepared);
}
