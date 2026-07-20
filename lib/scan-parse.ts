/**
 * Normalizes a raw scanned QR string into a recipient token the Send flow
 * already resolves (`/app/pay?to=…`). Mirrors the iOS parser
 * (ios/Talise/Features/Scan/ScanPayload.swift) so a code that scans in the
 * native app scans on the web and vice-versa:
 *
 *   • talise://pay/<handle>?amount=…           (deep link)
 *   • https://<any>.talise.io/pay/<handle>     (web share links / QR)
 *   • sui:<address> / sui://<address>          (our Receive QR + other wallets)
 *   • bare 0x Sui address
 *   • bare @handle / handle / name.sui
 */
export type ScannedRecipient = { recipient: string; amount: number | null };

const SUI_ADDR = /^0x[0-9a-fA-F]{1,64}$/;

export function parseScan(raw: string): ScannedRecipient | null {
  const s = raw.trim();
  if (!s) return null;

  return (
    parseTaliseDeepLink(s) ??
    parseWebPayUrl(s) ??
    parseSuiUri(s) ??
    parseBareAddress(s) ??
    parseHandleToken(s)
  );
}

function amountFrom(url: URL): number | null {
  const v = url.searchParams.get("amount");
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tokenToRecipient(token: string): string | null {
  if (SUI_ADDR.test(token)) return token;
  return normalizeHandle(token);
}

function parseTaliseDeepLink(s: string): ScannedRecipient | null {
  if (!/^talise:\/\//i.test(s)) return null;
  try {
    const url = new URL(s);
    if (url.host.toLowerCase() !== "pay") return null;
    const token = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
    const recipient = token && tokenToRecipient(token);
    return recipient ? { recipient, amount: amountFrom(url) } : null;
  } catch {
    return null;
  }
}

function parseWebPayUrl(s: string): ScannedRecipient | null {
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const url = new URL(s);
    const host = url.hostname.toLowerCase();
    if (host !== "talise.io" && !host.endsWith(".talise.io")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "app") parts.shift();
    if (parts.length !== 2 || parts[0].toLowerCase() !== "pay") return null;
    const recipient = tokenToRecipient(decodeURIComponent(parts[1]));
    return recipient ? { recipient, amount: amountFrom(url) } : null;
  } catch {
    return null;
  }
}

function parseSuiUri(s: string): ScannedRecipient | null {
  const m = s.match(/^sui:(?:\/\/)?(.+)$/i);
  if (!m) return null;
  const [tokenPart, query] = m[1].split("?");
  const token = tokenPart.replace(/^\/+|\/+$/g, "");
  const recipient = token && tokenToRecipient(token);
  if (!recipient) return null;
  let amount: number | null = null;
  if (query) {
    const n = parseFloat(new URLSearchParams(query).get("amount") ?? "");
    amount = Number.isFinite(n) && n > 0 ? n : null;
  }
  return { recipient, amount };
}

function parseBareAddress(s: string): ScannedRecipient | null {
  return SUI_ADDR.test(s) ? { recipient: s, amount: null } : null;
}

function parseHandleToken(s: string): ScannedRecipient | null {
  const h = normalizeHandle(s);
  return h ? { recipient: h, amount: null } : null;
}

/** Bare handle / @handle / SuiNS name → resolver-ready token. */
function normalizeHandle(s: string): string | null {
  let t = s;
  if (/\s/.test(t) || /^http/i.test(t)) return null;
  const lower = t.toLowerCase();
  // SuiNS names pass through verbatim, the server resolver keys on these.
  if (lower.endsWith(".sui") || lower.endsWith("@talise.sui")) return t;
  if (t.startsWith("@")) t = t.slice(1);
  // ≥3 chars of [alnum._-] so stray scanned text can't become a send target
  // (mirrors the Send resolver's own gate).
  if (!/^[A-Za-z0-9._-]{3,}$/.test(t)) return null;
  return t;
}
