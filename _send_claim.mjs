import { Resend } from "resend";
import postgres from "postgres";
import fs from "fs";
const txt = fs.readFileSync(".env.local", "utf8");
const env = {};
for (const l of txt.split("\n")) { const i = l.indexOf("="); if (i < 0 || l.trim().startsWith("#")) continue; env[l.slice(0,i).trim()] = l.slice(i+1).trim().replace(/^["']|["']$/g, ""); }
const mode = process.argv[2] || "test";
const TEST_ADDR = "exorbilabs@gmail.com";
const from = env.WAITLIST_FROM_EMAIL || "Talise <waitlist@talise.io>";
const replyTo = env.WAITLIST_REPLY_TO || env.EMAIL_REPLY_TO || undefined;
const subject = "Your Talise name is ready to claim";
const html = `
<div style="background:#ecf8e0;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:460px;margin:0 auto;background:#ffffff;border:1px solid #cfe7bd;border-radius:20px;padding:32px;">
    <div style="font-size:15px;font-weight:600;letter-spacing:-.01em;color:#15300c;">talise</div>
    <h1 style="font-size:24px;line-height:1.25;color:#15300c;margin:18px 0 10px;font-weight:600;">Your Talise name is ready to claim.</h1>
    <p style="font-size:14px;line-height:1.6;color:#46663a;margin:0 0 24px;">You signed in but haven't picked your <strong style="color:#15300c;">@handle</strong> yet &mdash; and if you tried recently and it didn't go through, that's fixed now. It mints free, straight to your wallet, in seconds. Good names go fast.</p>
    <a href="https://www.talise.io/waitlist" style="display:inline-block;background:#3d7a29;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 28px;border-radius:999px;">Claim your name</a>
    <p style="font-size:12px;line-height:1.6;color:#557050;margin:24px 0 0;">Or open <a href="https://www.talise.io/waitlist" style="color:#3c7a2a;">talise.io/waitlist</a> and sign in with the same Google account.</p>
  </div>
</div>`;
const resend = new Resend(env.RESEND_API_KEY);
let recipients = [TEST_ADDR];
if (mode === "blast") {
  const url = env.DATABASE_URL; const m = new URL(url).searchParams.get("sslmode");
  const ssl = m === "disable" ? false : (m === "require" ? { rejectUnauthorized: false } : "prefer");
  const sql = postgres(url, { ssl, max: 1, connect_timeout: 10 });
  const rows = await sql`SELECT email FROM users WHERE talise_username IS NULL AND email IS NOT NULL AND email <> '' ORDER BY created_at DESC`;
  await sql.end();
  recipients = [...new Set(rows.map(r => r.email.trim().toLowerCase()))];
}
console.log("MODE:", mode, "| recipients:", recipients.length);
let ok = 0, fail = 0;
for (const to of recipients) {
  const r = await resend.emails.send({ from, to, subject, html, ...(replyTo ? { replyTo } : {}) });
  if (r.error) { fail++; console.log("  ✗", to, JSON.stringify(r.error)); }
  else { ok++; console.log("  ✓", to, r.data?.id); }
  await new Promise(res => setTimeout(res, 120));
}
console.log(`done: ${ok} sent, ${fail} failed`);
