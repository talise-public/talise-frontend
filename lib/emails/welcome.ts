/**
 * Welcome-email HTML templates. Plain string templates (no JSX) so they're
 * bulletproof across email clients and have zero compile-time surprises.
 *
 * Design: light cream background, gold accent, Georgia serif headline.
 * Light-mode-first because email clients (especially Gmail) mangle dark mode.
 */

const BG = "#faf8f4";
const SURFACE = "#ffffff";
const FG = "#1a1916";
const FG_MUTED = "#5b574f";
const FG_DIM = "#9a958c";
const ACCENT = "#b8945f";
const LINE = "#e8e1d1";

function shell(opts: { previewText: string; body: string }): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>Talise</title>
<style>
  /* Force light rendering even when client is in dark mode. */
  :root { color-scheme: light only; supported-color-schemes: light only; }
  @media (prefers-color-scheme: dark) {
    body, .email-body, .card, .surface { background: ${BG} !important; color: ${FG} !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BG};color:${FG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="display:none;overflow:hidden;line-height:1px;max-height:0;max-width:0;opacity:0;mso-hide:all;">${opts.previewText}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">
        ${opts.body}
        <tr><td style="padding:32px 4px 8px 4px;color:${FG_DIM};font-size:12px;line-height:1.6;">
          Built on Sui · DeepBook · zkLogin · <a href="https://talise.io" style="color:${FG_DIM};text-decoration:underline;">talise.io</a>
        </td></tr>
        <tr><td style="padding:0 4px 24px 4px;color:${FG_DIM};font-size:11px;line-height:1.6;">
          You received this because you joined the Talise waitlist. Reply to this email if you want to talk.
        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function wordmark(): string {
  return /* html */ `
  <tr><td style="padding:0 4px 32px 4px;">
    <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:-0.01em;color:${FG};">talise</span>
  </td></tr>`;
}

function pillars(): string {
  const items = [
    "Hold USD, gold, bitcoin in one account",
    "Earning DeepBook yield by default",
    "Sign in with Google, no bank, no seed phrase",
    "Send any asset to anyone in one transaction",
  ];
  const rows = items
    .map(
      (it) => /* html */ `
        <tr><td style="padding:8px 0;font-size:14px;line-height:1.6;color:${FG_MUTED};">
          <span style="color:${ACCENT};font-weight:600;margin-right:8px;">-</span>${it}
        </td></tr>`
    )
    .join("");
  return /* html */ `
  <tr><td style="padding:8px 4px 0 4px;">
    <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${FG_DIM};margin-bottom:8px;">What you're waiting for</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>
  </td></tr>`;
}

function shareRow(intent: string): string {
  return /* html */ `
  <tr><td style="padding:24px 4px 0 4px;">
    <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${FG_DIM};margin-bottom:10px;">Keep us warm</div>
    <div style="font-size:14px;line-height:1.6;color:${FG_MUTED};margin-bottom:14px;">
      Reply to this email. Or share Talise with one person who'd want this:
    </div>
    <a href="${intent}" style="display:inline-block;border:1px solid ${LINE};background:${SURFACE};color:${FG};text-decoration:none;font-size:14px;padding:10px 16px;border-radius:6px;">
      Share on X &rarr;
    </a>
  </td></tr>`;
}

export type WelcomeData = {
  firstName: string | null;
  suiAddress: string;
  position: number;
};

export function welcomeWithAddressHtml(d: WelcomeData): string {
  const name = (d.firstName || "friend").trim();
  // Defensive: the address is server-derived (always 0x-hex) today, but
  // escape + format-guard it so a future caller-controlled value can't break
  // out of the href attribute or inject markup into the email body.
  const addrOk = /^0x[0-9a-f]{1,64}$/i.test(d.suiAddress);
  const suiscan = addrOk
    ? `https://suiscan.xyz/testnet/account/${d.suiAddress}`
    : "#";
  const tweet = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    "I just joined the Talise waitlist. Programmable money on @SuiNetwork. Earning by default."
  )}&url=https%3A%2F%2Ftalise.io`;

  const body = /* html */ `
    ${wordmark()}
    <tr><td style="padding:0 4px;">
      <div style="font-size:12px;letter-spacing:0.06em;color:${ACCENT};margin-bottom:12px;">
      , position #${d.position}
      </div>
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:40px;line-height:1.05;letter-spacing:-0.02em;margin:0 0 16px 0;color:${FG};">
        You&rsquo;re in, <span style="color:${FG_MUTED};">${escapeHtml(name)}</span>.
      </h1>
      <p style="font-size:15px;line-height:1.6;color:${FG_MUTED};margin:0 0 28px 0;">
        We minted you a non-custodial Sui address. It&rsquo;s yours forever.
        When Talise opens, this is where your money lives.
      </p>
    </td></tr>

    <tr><td style="padding:0 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE};border:1px solid ${LINE};border-radius:10px;">
        <tr><td style="padding:18px 20px;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${FG_DIM};margin-bottom:8px;">Your Sui address</div>
          <div style="font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:13px;color:${FG};word-break:break-all;line-height:1.5;">${escapeHtml(d.suiAddress)}</div>
          <div style="margin-top:14px;">
            <a href="${suiscan}" style="color:${ACCENT};text-decoration:underline;font-size:13px;">View on Suiscan &nearr;</a>
          </div>
        </td></tr>
      </table>
    </td></tr>

    ${pillars()}
    ${shareRow(tweet)}

    <tr><td style="padding:28px 4px 0 4px;font-size:12px;line-height:1.6;color:${FG_DIM};">
      We never see your Google password. The salt that ties your account to this address
      is stored encrypted on our servers, when Talise launches, signing in with the same
      Google account restores this exact wallet.
    </td></tr>
  `;

  return shell({
    previewText: `You're in. Your Sui address is ${shortAddr(d.suiAddress)}.`,
    body,
  });
}

export function welcomeEmailOnlyHtml(position: number): string {
  const claimUrl = "https://talise.io/";
  const tweet = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    "I just joined the Talise waitlist. Programmable money on @SuiNetwork."
  )}&url=https%3A%2F%2Ftalise.io`;

  const body = /* html */ `
    ${wordmark()}
    <tr><td style="padding:0 4px;">
      <div style="font-size:12px;letter-spacing:0.06em;color:${ACCENT};margin-bottom:12px;">
      , position #${position}
      </div>
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:40px;line-height:1.05;letter-spacing:-0.02em;margin:0 0 16px 0;color:${FG};">
        You&rsquo;re in.
      </h1>
      <p style="font-size:15px;line-height:1.6;color:${FG_MUTED};margin:0 0 24px 0;">
        We&rsquo;ve got your email. When Talise opens you&rsquo;ll be one of the first to know.
      </p>
      <p style="font-size:15px;line-height:1.6;color:${FG_MUTED};margin:0 0 24px 0;">
        Want a non-custodial Sui address minted now? Sign in with Google &mdash; it takes three taps and you&rsquo;ll have a wallet waiting for launch day.
      </p>
      <a href="${claimUrl}" style="display:inline-block;background:${FG};color:${BG};text-decoration:none;font-size:14px;padding:12px 20px;border-radius:6px;font-weight:500;">
        Claim your Sui address &rarr;
      </a>
    </td></tr>

    ${pillars()}
    ${shareRow(tweet)}
  `;

  return shell({
    previewText: `You're in. Want a Sui address too?`,
    body,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortAddr(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}
