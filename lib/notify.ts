import "server-only";

import { userBySuiAddress, deviceTokensForUser } from "@/lib/db";
import { sendInboundReceivedEmail } from "@/lib/email";
import { sendApnsPush } from "@/lib/apns";

/**
 * Format a USD amount for notification copy: "$0.2", "$5", "$12.34". We show
 * the ACTUAL USD value received (USDsui is dollar-denominated), NOT a
 * local-currency conversion, converting was the source of a wrong figure in
 * the push (a $0.36 credit displayed as "₦597"). USD is exact and matches the
 * dollars the user actually holds.
 */
function formatUsd(n: number): string {
  const r = Math.round((Number(n) || 0) * 100) / 100;
  if (Number.isInteger(r)) return `$${r}`;
  return `$${r.toFixed(2).replace(/0$/, "")}`;
}

/**
 * Whether to email the recipient when they receive money. OFF by default -
 * the push notification is the credit alert; receive-emails are paused. Flip
 * with `RECEIVE_EMAIL_ENABLED=true` in Vercel to turn them back on.
 */
function receiveEmailEnabled(): boolean {
  return process.env.RECEIVE_EMAIL_ENABLED?.trim().toLowerCase() === "true";
}

/** "caleb" / "caleb.sui" → "caleb@talise"; leaves real display names alone. */
function senderLabel(raw: string): string {
  const s = raw.trim();
  if (!s) return "someone on Talise";
  if (/^[a-z0-9_.-]{3,}$/i.test(s) && !s.includes("@") && !s.includes(" ")) {
    return `${s.replace(/\.sui$/i, "").replace(/\.talise$/i, "")}@talise`;
  }
  return s;
}

/**
 * Notify the RECIPIENT that an inbound transfer settled on chain.
 *
 * Fire-and-forget by contract: this NEVER throws, a notification failure
 * must never affect the send that already landed. Today it emails the
 * recipient via Resend; the push (APNs) leg hooks in here once device-token
 * registration + the Apple Push key are wired (see docs/hackathon/PLAN.md).
 *
 * The recipient is resolved from their Sui address; an external (non-Talise)
 * address resolves to null and is silently skipped.
 */
export async function notifyInboundSettlement(input: {
  recipientAddress: string;
  amountUsd: number;
  senderName: string;
}): Promise<void> {
  try {
    const recipient = await userBySuiAddress(input.recipientAddress);
    if (!recipient) return; // external (non-Talise) address, nothing to notify

    // Email on receive, OFF by default; the push below is the primary credit
    // notification. Toggle back on with RECEIVE_EMAIL_ENABLED=true in Vercel.
    if (recipient.email && receiveEmailEnabled()) {
      const res = await sendInboundReceivedEmail({
        to: recipient.email,
        amountUsd: input.amountUsd,
        senderName: input.senderName,
      });
      if (!res.ok) {
        console.warn(
          `[notify] inbound email failed to=${recipient.email}: ${res.reason}`
        );
      }
    }

    // Push (APNs), fire to every registered device. No-ops cleanly when APNs
    // isn't configured (sendApnsPush returns { skipped: true }).
    try {
      const tokens = await deviceTokensForUser(recipient.id);
      if (tokens.length > 0) {
        // Title leads with the money (USD, not a converted local amount); the
        // body names the sender by their @talise handle. The app NAME
        // ("Talise") + icon render as the header automatically.
        const amountText = formatUsd(input.amountUsd); // "$0.2"
        const title = `💰 You just received ${amountText}`;
        const pbody = `from ${senderLabel(input.senderName)}`;
        await Promise.all(
          tokens.map((t) =>
            sendApnsPush(t, {
              title,
              body: pbody,
              threadId: "talise-credit",
              category: "TALISE_CREDIT",
              interruptionLevel: "active",
              relevanceScore: 1,
              data: { kind: "credit", route: "activity", amountUsd: input.amountUsd },
            }).then((r) => {
              if (!r.ok && !r.skipped) {
                console.warn(
                  `[notify] apns push failed token=${t.slice(0, 8)}…: ${r.reason}`
                );
              }
            })
          )
        );
      }
    } catch (e) {
      console.warn(`[notify] push leg failed: ${(e as Error).message}`);
    }
  } catch (e) {
    console.warn(
      `[notify] inbound settlement notify failed: ${(e as Error).message}`
    );
  }
}
