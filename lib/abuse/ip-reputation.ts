/**
 * IP reputation for the growth surface — edge-safe, dependency-free.
 *
 * Replaces the two inline Tencent literals that lived in middleware.ts
 * (added 2026-06-07 after a datacenter IP flooded the waitlist) with a
 * maintainable, greppable list. Two independent tiers, deliberately:
 *
 *   1. HARD DENY  — exact IPs / CIDRs that get 403 on EVERY path at the
 *      edge, before any route or DB touch. Seeded with the same two
 *      Tencent Cloud IPs as before (behaviour preserved bit-for-bit) and
 *      extensible without a deploy via `BLOCKED_IPS` (existing var, now
 *      also accepts CIDR notation) and `BLOCKED_CIDRS`.
 *
 *   2. DATACENTER — coarse ranges belonging to cloud/VPS providers. These
 *      are NOT hard-blocked: commercial VPNs run on exactly this kind of
 *      address space, and blanket-403ing a Hetzner or DigitalOcean range
 *      would lock real users out of a real-money wallet. Instead the
 *      growth-surface guard (lib/abuse/guard.ts) DIVIDES the per-IP limit
 *      for these sources, so a scripted referral farm running on a VPS
 *      trips the limiter ~10× sooner than a phone on cellular. Escalate
 *      to a hard 403 on the growth routes only with
 *      `ABUSE_BLOCK_DATACENTER=true` if a flood is in progress.
 *
 * Why a curated CIDR list and not ASN lookup: Vercel gives us no ASN
 * header (only `x-vercel-ip-country`), and an IP-intel API call on the
 * request path would add latency + a hard dependency to every signup. The
 * ASN is recorded alongside each range for documentation/attribution only.
 * The list is intentionally coarse and incomplete — it is a cost multiplier
 * for abuse, not a boundary. Extend at runtime with
 * `ABUSE_DATACENTER_CIDRS` ("cidr:Org, cidr:Org, …").
 *
 * AWS / GCP / Azure ranges are deliberately absent: they are enormous,
 * change weekly, and are published as multi-thousand-entry JSON. Loading
 * that at the edge is the wrong trade; if we need them, the right fix is a
 * cached IP-intel provider behind this same module's API.
 *
 * IPv6: matched by exact (lower-cased) string only. Real IPv6 prefix math
 * needs BigInt parsing of every form of `::` compression, which is not
 * worth it while every abuse case we've actually seen has been IPv4. An
 * IPv6 abuser is still caught by the per-IP rate limits.
 */

export interface IpRange {
  /** IPv4 CIDR, e.g. "43.128.0.0/10". */
  cidr: string;
  /** Human-readable owner, used in logs. */
  org: string;
  /** Autonomous system number, for attribution when we escalate to abuse@. */
  asn?: number;
  note?: string;
}

/**
 * Known cloud / VPS address space. Ordered loosely by how often we've seen
 * abuse from it. Tencent is first because it is the range that actually hit
 * us (the two /32s below are still hard-denied).
 */
const DATACENTER_RANGES: readonly IpRange[] = [
  // Tencent Cloud (Aceville / Tencent Building). Source of the 2026-06-07
  // waitlist flood; 43.134.125.171 + 43.134.189.52 both live in this /10.
  { cidr: "43.128.0.0/10", org: "Tencent Cloud", asn: 132203 },
  { cidr: "124.156.0.0/16", org: "Tencent Cloud", asn: 132203 },
  { cidr: "129.226.0.0/16", org: "Tencent Cloud", asn: 132203 },
  { cidr: "150.109.0.0/16", org: "Tencent Cloud", asn: 132203 },
  { cidr: "170.106.0.0/16", org: "Tencent Cloud", asn: 132203 },
  // Alibaba Cloud (Singapore/US ranges commonly used for scripted signups).
  { cidr: "8.208.0.0/12", org: "Alibaba Cloud", asn: 45102 },
  { cidr: "47.74.0.0/15", org: "Alibaba Cloud", asn: 45102 },
  { cidr: "47.88.0.0/14", org: "Alibaba Cloud", asn: 45102 },
  // DigitalOcean — cheapest place to rent an IP for a signup script.
  { cidr: "104.131.0.0/16", org: "DigitalOcean", asn: 14061 },
  { cidr: "138.197.0.0/16", org: "DigitalOcean", asn: 14061 },
  { cidr: "143.198.0.0/16", org: "DigitalOcean", asn: 14061 },
  { cidr: "159.203.0.0/16", org: "DigitalOcean", asn: 14061 },
  { cidr: "165.227.0.0/16", org: "DigitalOcean", asn: 14061 },
  { cidr: "167.99.0.0/16", org: "DigitalOcean", asn: 14061 },
  { cidr: "68.183.0.0/16", org: "DigitalOcean", asn: 14061 },
  // Hetzner.
  { cidr: "5.9.0.0/16", org: "Hetzner", asn: 24940 },
  { cidr: "65.21.0.0/16", org: "Hetzner", asn: 24940 },
  { cidr: "65.108.0.0/16", org: "Hetzner", asn: 24940 },
  { cidr: "88.99.0.0/16", org: "Hetzner", asn: 24940 },
  { cidr: "95.216.0.0/16", org: "Hetzner", asn: 24940 },
  { cidr: "116.202.0.0/15", org: "Hetzner", asn: 24940 },
  { cidr: "135.181.0.0/16", org: "Hetzner", asn: 24940 },
  // Vultr / Choopa.
  { cidr: "45.32.0.0/16", org: "Vultr", asn: 20473 },
  { cidr: "45.63.0.0/16", org: "Vultr", asn: 20473 },
  { cidr: "45.76.0.0/16", org: "Vultr", asn: 20473 },
  { cidr: "108.61.0.0/16", org: "Vultr", asn: 20473 },
  { cidr: "149.28.0.0/16", org: "Vultr", asn: 20473 },
  // Linode / Akamai.
  { cidr: "45.33.0.0/16", org: "Linode", asn: 63949 },
  { cidr: "45.56.0.0/16", org: "Linode", asn: 63949 },
  { cidr: "139.162.0.0/16", org: "Linode", asn: 63949 },
  { cidr: "172.104.0.0/15", org: "Linode", asn: 63949 },
  { cidr: "173.255.192.0/18", org: "Linode", asn: 63949 },
  // Contabo — very cheap VPS, over-represented in credential/signup abuse.
  { cidr: "144.91.64.0/18", org: "Contabo", asn: 51167 },
  { cidr: "161.97.64.0/18", org: "Contabo", asn: 51167 },
  { cidr: "173.212.192.0/18", org: "Contabo", asn: 51167 },
];

/**
 * Hard-deny seeds. These are the EXACT two addresses middleware.ts blocked
 * inline; keeping them as /32s means the edge behaviour is unchanged while
 * the mechanism is now generic. Do not widen these to the parent /10 — the
 * datacenter tier already handles the range, at a proportionate cost.
 */
const HARD_DENY_SEEDS: readonly IpRange[] = [
  { cidr: "43.134.125.171/32", org: "Tencent Cloud", asn: 132203, note: "waitlist flood 2026-06-07" },
  { cidr: "43.134.189.52/32", org: "Tencent Cloud", asn: 132203, note: "waitlist flood 2026-06-07" },
];

// ── IPv4 CIDR matching ───────────────────────────────────────────────

interface CompiledRange extends IpRange {
  /** Network address as a 32-bit unsigned int. */
  net: number;
  /** Prefix mask as a 32-bit unsigned int. */
  mask: number;
}

/** Parse dotted-quad IPv4 into a uint32. Returns null for anything else. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    // Reject empty / non-numeric / out-of-range octets. Zero-padded octets
    // are ACCEPTED and normalised ("043" → 43) on purpose: a padded
    // "043.134.125.171" would slip past an exact-string denylist, but here it
    // resolves to the same integer and stays denied.
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Compile "a.b.c.d/len" (bare IP ⇒ /32). Returns null if unparseable. */
function compileRange(r: IpRange): CompiledRange | null {
  const [addr, lenRaw] = r.cidr.split("/");
  const net = parseIpv4((addr ?? "").trim());
  if (net === null) return null;
  const len = lenRaw === undefined ? 32 : Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > 32) return null;
  // len === 0 would make `-1 << 32` wrap to -1 in JS, so special-case it.
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { ...r, net: (net & mask) >>> 0, mask };
}

function compileAll(ranges: readonly IpRange[]): CompiledRange[] {
  const out: CompiledRange[] = [];
  for (const r of ranges) {
    const c = compileRange(r);
    if (c) out.push(c);
    else console.warn(`[abuse] event=bad_cidr cidr=${r.cidr} org=${r.org}`);
  }
  return out;
}

/**
 * Parse an env list. Accepts bare IPs and CIDRs, optionally suffixed with
 * `:Org` for log attribution: `"1.2.3.4, 5.6.0.0/16:BadCloud"`.
 */
function parseEnvRanges(raw: string | undefined, defaultOrg: string): IpRange[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [cidr, org] = entry.split(":");
      return { cidr: (cidr ?? "").trim(), org: (org ?? "").trim() || defaultOrg };
    })
    .filter((r) => r.cidr.length > 0);
}

const ENV_HARD_DENY = [
  ...parseEnvRanges(process.env.BLOCKED_IPS, "env:BLOCKED_IPS"),
  ...parseEnvRanges(process.env.BLOCKED_CIDRS, "env:BLOCKED_CIDRS"),
];

const HARD_DENY_V4: readonly CompiledRange[] = compileAll([
  ...HARD_DENY_SEEDS,
  ...ENV_HARD_DENY,
]);

/**
 * IPv6 (and any other unparseable) hard-deny entries, matched by exact
 * lower-cased string. See the module header for why we don't do v6 prefix
 * math.
 */
const HARD_DENY_LITERAL: ReadonlySet<string> = new Set(
  [...HARD_DENY_SEEDS, ...ENV_HARD_DENY]
    .filter((r) => parseIpv4(r.cidr.split("/")[0] ?? "") === null)
    .map((r) => r.cidr.toLowerCase())
);

const DATACENTER_V4: readonly CompiledRange[] = compileAll([
  ...DATACENTER_RANGES,
  ...parseEnvRanges(process.env.ABUSE_DATACENTER_CIDRS, "env:datacenter"),
]);

function matchRange(ip: string, ranges: readonly CompiledRange[]): CompiledRange | null {
  const v4 = parseIpv4(ip);
  if (v4 === null) return null;
  for (const r of ranges) {
    if (((v4 & r.mask) >>> 0) === r.net) return r;
  }
  return null;
}

export interface IpVerdict {
  ip: string;
  /** True ⇒ 403 at the edge, on every path. */
  hardDenied: boolean;
  /** Which rule denied it (for the log line). */
  deniedBy: IpRange | null;
  /** Non-null ⇒ known cloud/VPS space; growth limits are tightened. */
  datacenter: IpRange | null;
}

/**
 * Classify a client IP. Cheap: a handful of integer compares, no I/O, so
 * it is safe to call from middleware on every request.
 */
export function classifyIp(ip: string): IpVerdict {
  const normalized = ip.trim().toLowerCase();
  const hard =
    matchRange(normalized, HARD_DENY_V4) ??
    (HARD_DENY_LITERAL.has(normalized)
      ? { cidr: normalized, org: "literal denylist" }
      : null);
  if (hard) {
    return { ip, hardDenied: true, deniedBy: hard, datacenter: null };
  }
  return {
    ip,
    hardDenied: false,
    deniedBy: null,
    datacenter: matchRange(normalized, DATACENTER_V4),
  };
}

/** True when the datacenter tier should 403 outright on growth routes. */
export function blockDatacenterOnGrowthRoutes(): boolean {
  return process.env.ABUSE_BLOCK_DATACENTER === "true";
}

/** Counts for boot-time observability (middleware logs these once). */
export function ipReputationStats(): { hardDeny: number; datacenter: number } {
  return {
    hardDeny: HARD_DENY_V4.length + HARD_DENY_LITERAL.size,
    datacenter: DATACENTER_V4.length,
  };
}

/**
 * Best-effort client IP, byte-identical in behaviour to
 * lib/rate-limit.ts#getClientIp but taking plain headers so it works in
 * BOTH the edge middleware (NextRequest) and node routes (Request)
 * without importing anything. Platform-set headers first: on Vercel
 * `x-vercel-forwarded-for` / `x-real-ip` are overwritten at ingress and
 * cannot be spoofed, while a raw `x-forwarded-for` IS client-controlled
 * (rotating it would otherwise reset every rate-limit bucket), so it is
 * the last resort.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const first = vercel.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = headers.get("x-real-ip");
  if (xri) return xri.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
