# Resend setup for Talise waitlist mail

End-to-end runbook for getting the `waitlist@talise.io` confirmation
email live. Roughly 15 to 30 minutes of clock time (mostly DNS
propagation).

## 1. Sign up at Resend

Go to https://resend.com and sign in with the Talise founder Google
account. The free tier covers 3,000 emails per month, which is plenty
for a private-beta waitlist.

## 2. Add the talise.io domain

In the Resend dashboard, open Domains, click Add Domain, and enter
`talise.io`. Pick the region closest to your users (US East is fine for
the Africa corridor while we are still small).

## 3. Add the DNS records

Resend will print one SPF, one DKIM, and one DMARC record (three TXT
rows total, sometimes one MX row for return path). Open the DNS
provider where `talise.io` is hosted (Cloudflare, Namecheap, Porkbun,
whichever), and add each row exactly as shown. Be careful with the
trailing dot and the underscore-prefixed names.

If `talise.io` already has an SPF record, do not duplicate the row.
Merge the Resend `include:_spf.resend.com` clause into the existing
record instead.

## 4. Verify the domain

Back in the Resend dashboard, hit Verify on the domain. DNS usually
propagates within 10 minutes. If it stalls past 30 minutes, double
check your records with `dig TXT _resend.talise.io` and
`dig TXT talise.io`.

## 5. Create an API key

In Resend, open API Keys, click Create API Key, name it
`talise-waitlist-prod`, and scope it to Sending Only. Copy the key
once. You cannot retrieve it later.

## 6. Push the env vars to Vercel

```
vercel env add RESEND_API_KEY
# paste the API key, scope: Production (and Preview if you want test sends)

vercel env add WAITLIST_FROM_EMAIL
# value: Talise <waitlist@talise.io>
```

## 7. Optional ops BCC

If you want every confirmation BCCed to an ops or founder inbox for
monitoring, add:

```
vercel env add WAITLIST_BCC_EMAIL
# value: ops@talise.io   (or your personal inbox)
```

Skip this if you do not want the noise.

## 8. Confirm the public app URL

The email template embeds `coming-soon-hero.png` via
`NEXT_PUBLIC_APP_URL/coming-soon-hero.png`. Make sure that var is set
to your production origin:

```
vercel env add NEXT_PUBLIC_APP_URL
# value: https://talise.io
```

If unset, the code falls back to `NEXT_PUBLIC_BASE_URL` and then to
`https://talise.io`, so this is belt-and-braces only.

## 9. Redeploy

```
vercel --prod
```

## 10. Smoke test

Open https://talise.io/waitlist on a clean browser, submit a real
inbox you control, and confirm:

1. The page flips to the "You're on the list." card.
2. The confirmation email lands within a minute or two.
3. The Talise hero image renders inline at the top.
4. The Resend dashboard shows the message under Logs with a green
   status and a message id.
5. The waitlist row in Postgres has `confirmation_sent_at` set and
   `confirmation_message_id` matching the Resend id.

If anything fails, check Vercel function logs for the
`[waitlist] confirmation send failed:` warning, which prints the
Resend error verbatim.
