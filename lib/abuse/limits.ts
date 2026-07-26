/**
 * A single fixed-window allowance. Declared HERE, not in guard.ts, so this
 * module stays a leaf: middleware.ts (edge runtime) imports the redeem limit
 * below and must not pull in guard.ts's Postgres/server-only dependencies.
 */
export interface AbuseLimit {
  /** Max requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/**
 * Every growth-surface limit, in one table, with the reasoning.
 *
 * Kept out of the route files so (a) a reviewer can see the whole policy at
 * a glance, (b) tightening a number during an attack is a one-line diff,
 * and (c) two routes can't drift apart on the same abuse vector.
 *
 * ── How the numbers were chosen ─────────────────────────────────────────
 * Upper bound: comfortably above the worst legitimate burst we can
 * construct (a user retrying, a debounced-keystroke UI, an iOS app cold
 * start fanning out, a family behind one NAT). Lower bound: low enough that
 * a script farming referrals/points hits it in seconds rather than hours.
 *
 * CGNAT CAVEAT — the reason several numbers here are LOOSER than the values
 * they replace. Mobile carriers put thousands of subscribers behind one
 * public IP, and Talise's users are overwhelmingly on cellular. The old
 * limits were per-lambda (effective cap ≈ N_instances × limit), so they
 * never bit a shared IP; enforcing the same numbers GLOBALLY would start
 * 429-ing real users the moment two or three people behind one carrier
 * egress hit the same flow. So per-IP caps on shared-IP-exposed routes are
 * raised, precision is moved to the per-USER cap where a user exists, and
 * the datacenter divisor (÷10) is what re-tightens the caps for the traffic
 * that is actually suspicious. Where a 429 would be user-hostile (the
 * /r/<CODE> invite landing) the route DEGRADES — serves the page, refuses
 * the attribution write — instead of erroring.
 *
 * Requests from known datacenter/VPS ranges get these per-IP allowances
 * divided by 10 automatically (lib/abuse/ip-reputation.ts) — no separate
 * numbers to maintain.
 */

/**
 * `GET /r/<CODE>` — the public invite landing. One page view per click;
 * link-preview bots (iMessage/WhatsApp/Slack) add a few unattributed
 * fetches. 30/min absorbs a preview storm plus impatient reloads, and
 * 300/h bounds a scripted attribution farm behind one IP. Deliberately
 * loose because this is the most CGNAT-exposed route we have; the real
 * defence is that exceeding it costs the caller the referral cookie.
 */
export const REFERRAL_LINK_IP: readonly AbuseLimit[] = [
  { limit: 30, windowSec: 60 },
  { limit: 300, windowSec: 3600 },
];

/**
 * `POST /api/referral/capture` — writes the signed `talise_ref` cookie from
 * `?ref=`. Fires once per landing-page mount that carries `?ref=`, so it
 * tracks invite-link traffic and gets the same shape as the link itself
 * (30/min + 300/h per IP): a viral push behind one carrier IP must not get
 * 429'd, while a VPS-hosted farm lands on 3/min + 30/h after the datacenter
 * divisor. The cookie alone is worthless to an attacker — it only pays out
 * at /api/onboarding, which has its own per-user cap.
 */
export const REFERRAL_CAPTURE_IP: readonly AbuseLimit[] = [
  { limit: 30, windowSec: 60 },
  { limit: 300, windowSec: 3600 },
];

/**
 * `GET /api/referral/cookie` — reads back the httpOnly cookie so the
 * onboarding form can prefill. Read-only and cheap, but it was completely
 * unmetered; 120/min is ~40× the real usage (one call per form mount) with
 * room for a shared carrier IP.
 */
export const REFERRAL_COOKIE_IP: AbuseLimit = { limit: 120, windowSec: 60 };

/**
 * `GET /api/referral/summary` — the authenticated rewards snapshot (iOS
 * Rewards card). It fans out three DB reads per call, so it's the most
 * expensive route on this surface. iOS refetches on app foreground and on
 * pull-to-refresh: 60/min per user is far above that while still capping a
 * single account's ability to hammer the pool; 240/min per IP allows a
 * shared-NAT household/office of authenticated users.
 */
export const REFERRAL_SUMMARY_USER: AbuseLimit = { limit: 60, windowSec: 60 };
export const REFERRAL_SUMMARY_IP: AbuseLimit = { limit: 240, windowSec: 60 };

/**
 * `POST /api/onboarding` — sets the account type ONCE per user (a second
 * call 409s) and is the route that actually mints the referral attribution
 * + points. So the legitimate per-user volume is ~1, plus retries after a
 * validation error (handle taken, name too short): 10/h is generous. That
 * per-user cap is the precise control here.
 *
 * The per-IP cap is the account-farm backstop and is deliberately loose
 * (120/h): onboarding happens in the iOS app over cellular, so a carrier
 * egress IP can legitimately carry a lot of first-time signups during a
 * launch push, and a false 429 here would kill our single most important
 * conversion step. A farm on a VPS gets 12/h after the datacenter divisor,
 * and must additionally satisfy App Attest.
 */
export const ONBOARDING_USER: AbuseLimit = { limit: 10, windowSec: 3600 };
export const ONBOARDING_IP: AbuseLimit = { limit: 120, windowSec: 3600 };

/**
 * `POST /api/waitlist/handle/availability` — the burst window does the real
 * work here: 10 per 5s stops a fast scripted scan of the handle namespace
 * cold, while a human on a 350ms-debounced input never reaches it. The
 * per-minute window is raised from the old 30 to 90 precisely BECAUSE it is
 * now global: one person typing can spend 20+ checks a minute, so three
 * users behind one carrier IP would have tripped a global 30.
 */
export const WAITLIST_AVAILABILITY_IP: readonly AbuseLimit[] = [
  { limit: 90, windowSec: 60 },
  { limit: 10, windowSec: 5 },
];

/**
 * `POST /api/waitlist/handle/claim` — mints a real on-chain SuiNS subname
 * with OUR gas. Highest-value target on this surface, so the per-USER cap is
 * the tight one: 5/h, when a user can only ever own ONE name (the only
 * legitimate repeats are retries after a taken-handle 409).
 *
 * Per-IP is 12/min + 60/h. The old value was 6/min per lambda; enforcing 6
 * globally would 429 real users during a launch (a carrier IP can carry more
 * than six claims a minute), so the burst window is doubled while the
 * sustained window is what bounds a grind. VPS traffic lands on 1/min + 6/h.
 */
export const WAITLIST_CLAIM_IP: readonly AbuseLimit[] = [
  { limit: 12, windowSec: 60 },
  { limit: 60, windowSec: 3600 },
];
export const WAITLIST_CLAIM_USER: AbuseLimit = { limit: 5, windowSec: 3600 };

/**
 * `GET /api/waitlist/handle/existing` — called once on form mount. Was 30/min
 * per lambda; 60/min globally keeps the same intent with shared-IP headroom.
 */
export const WAITLIST_EXISTING_IP: AbuseLimit = { limit: 60, windowSec: 60 };

/**
 * `GET /api/waitlist/status` — was unmetered. Runs `getWaitlistRank`, a
 * ranking query over the whole signup table, which is the expensive part.
 * The dashboard polls it at most on mount + after a claim.
 */
export const WAITLIST_STATUS_USER: AbuseLimit = { limit: 30, windowSec: 60 };
export const WAITLIST_STATUS_IP: AbuseLimit = { limit: 120, windowSec: 60 };

/**
 * `POST /api/rewards/redeem` — enforced at the EDGE (middleware.ts) because
 * the route file is owned elsewhere. Redemptions are rare and deliberate (a
 * user spends points for a perk), so 30/h per IP is far above real usage —
 * with carrier-NAT headroom, since the edge can't tell users apart (no
 * session verification there) — while still capping a scripted drain of a
 * compromised account's balance. Edge-only means Upstash-or-nothing (no
 * Postgres at the edge), so this one fails OPEN when Upstash is unset — see
 * the note in middleware.ts.
 */
export const REWARDS_REDEEM_IP: AbuseLimit = { limit: 30, windowSec: 3600 };
