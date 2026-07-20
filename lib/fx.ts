/**
 * Thin FX/currency layer for Talise.
 *
 * The underlying balance is held in USDsui (Sui-native USD, pegged 1:1 to
 * USD just like USDC). Users see a local African currency (Naira ₦ by
 * default) as primary, with USD as a small secondary line.
 *
 * Rates here are a hardcoded Q2 2026 snapshot used as the DISPLAY/offline
 * fallback. The server-authoritative, executable rates for quote generation
 * live in `fx-feed.ts` (live API + per-corridor spread + max-age breaker).
 * The helpers in THIS file remain pure (no I/O) and backward-compatible.
 *
 * Currencies span the African corridors (NGN/KES/GHS/ZAR), the global/USD
 * anchor (USD), and the Asian/global expansion set (JPY/SGD/PHP/IDR/VND).
 */

export type Currency =
  // African corridors
  | "NGN"
  | "KES"
  | "GHS"
  | "ZAR"
  // global anchor
  | "USD"
  // Asian / global expansion
  | "JPY"
  | "SGD"
  | "PHP"
  | "IDR"
  | "VND";

/**
 * Units of `currency` per 1 USD, a hardcoded Q2 2026 snapshot.
 *
 * Used ONLY as a display fallback and as the seed/sanity reference for the
 * live feed. Quote pricing MUST go through `fx-feed.ts` (`getQuote`), which
 * sources executable rates and rejects stale feeds. Do not price money off
 * these constants.
 */
export const FX: Record<Currency, number> = {
  // African corridors
  NGN: 1620,
  KES: 132,
  GHS: 14,
  ZAR: 18.5,
  // global anchor
  USD: 1,
  // Asian / global expansion (Q2 2026 snapshot)
  JPY: 157,
  SGD: 1.34,
  PHP: 58,
  IDR: 16200,
  VND: 25400,
};

/** Display prefix for each currency (note trailing space on multi-char prefixes). */
export const SYMBOL: Record<Currency, string> = {
  NGN: "₦",
  KES: "KSh ",
  GHS: "GH₵ ",
  ZAR: "R ",
  USD: "$",
  JPY: "¥",
  SGD: "S$",
  PHP: "₱",
  IDR: "Rp ",
  VND: "₫ ",
};

/**
 * Country/region flag (emoji) per currency, renders the corridor visually in
 * pickers + amount chips. Emoji flags render natively on macOS/iOS/Android
 * (Talise's audience). On Windows Chrome they fall back to the 2-letter code;
 * drop in the MIT `flag-icons` package there if pixel-perfect flags are needed.
 */
export const FLAG: Record<Currency, string> = {
  NGN: "🇳🇬",
  KES: "🇰🇪",
  GHS: "🇬🇭",
  ZAR: "🇿🇦",
  USD: "🇺🇸",
  JPY: "🇯🇵",
  SGD: "🇸🇬",
  PHP: "🇵🇭",
  IDR: "🇮🇩",
  VND: "🇻🇳",
};

/**
 * ISO-3166 alpha-2 country code per currency, keys the circle-flag SVGs
 * vendored at `/public/flags/<cc>.svg` (HatScripts/circle-flags, MIT). Used by
 * the <Flag/> component so pickers render crisp circular flags instead of the
 * emoji fallback (which doesn't render on Windows Chrome).
 */
// Keyed by string (not Currency) so display-only currencies the picker also
// lists (EUR/GBP/CAD) get a flag without forcing entries into FX/FLAG/NAME.
export const CC: Record<string, string> = {
  NGN: "ng",
  KES: "ke",
  GHS: "gh",
  ZAR: "za",
  USD: "us",
  JPY: "jp",
  SGD: "sg",
  PHP: "ph",
  IDR: "id",
  VND: "vn",
  EUR: "eu",
  GBP: "gb",
  CAD: "ca",
};

/** Full display name per currency (for pickers). */
export const CURRENCY_NAME: Record<Currency, string> = {
  NGN: "Nigerian Naira",
  KES: "Kenyan Shilling",
  GHS: "Ghanaian Cedi",
  ZAR: "South African Rand",
  USD: "US Dollar",
  JPY: "Japanese Yen",
  SGD: "Singapore Dollar",
  PHP: "Philippine Peso",
  IDR: "Indonesian Rupiah",
  VND: "Vietnamese Dong",
};

/**
 * Currencies conventionally displayed without a fractional part (the minor
 * unit is negligible or unused in everyday pricing). Everything else shows
 * 2 decimals.
 */
const ZERO_DECIMAL: ReadonlySet<Currency> = new Set<Currency>([
  "NGN",
  "KES",
  "GHS",
  "JPY",
  "IDR",
  "VND",
]);

/** Number of fractional digits to display for a currency. */
function fractionDigits(currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/**
 * Convert a USDsui amount (treated 1:1 with USD) to the given local currency.
 * Whole units for zero-decimal currencies, 2 decimals otherwise.
 */
export function usdcToLocal(amountUsdsui: number, currency: Currency): number {
  const raw = amountUsdsui * FX[currency];
  if (fractionDigits(currency) === 0) {
    return Math.round(raw);
  }
  return Math.round(raw * 100) / 100;
}

/** Locale used for grouping/decimals in each currency's display. */
const LOCALE: Record<Currency, string> = {
  NGN: "en-NG",
  KES: "en-KE",
  GHS: "en-GH",
  ZAR: "en-ZA",
  USD: "en-US",
  JPY: "ja-JP",
  SGD: "en-SG",
  PHP: "en-PH",
  IDR: "id-ID",
  VND: "vi-VN",
};

/**
 * Format a USDsui balance for display in the given local currency.
 * e.g. `formatLocal(100, "NGN")` -> `"₦162,000"`,
 *      `formatLocal(100, "USD")` -> `"$100.00"`.
 */
export function formatLocal(amountUsdsui: number, currency: Currency): string {
  const local = usdcToLocal(amountUsdsui, currency);
  const digits = fractionDigits(currency);
  const formatted = new Intl.NumberFormat(LOCALE[currency], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(local);
  return `${SYMBOL[currency]}${formatted}`;
}

/** Default display currency. Geo-detection will replace this later. */
export function defaultCurrency(): Currency {
  return "NGN";
}

/**
 * Inverse of `usdcToLocal`. Convert a local-currency amount back to USDsui
 * (treated 1:1 with USD). Used when the user types an amount in their
 * preferred currency and we need to settle in USDsui under the hood.
 */
export function localToUsdsui(amountLocal: number, currency: Currency): number {
  return amountLocal / FX[currency];
}

/** All supported currencies, in a stable order (corridors, then anchor, then Asia/global). */
export const ALL_CURRENCIES: readonly Currency[] = [
  "NGN",
  "KES",
  "GHS",
  "ZAR",
  "USD",
  "JPY",
  "SGD",
  "PHP",
  "IDR",
  "VND",
];

/** Type guard: is `x` a supported `Currency`? */
export function isCurrency(x: unknown): x is Currency {
  return typeof x === "string" && (ALL_CURRENCIES as readonly string[]).includes(x);
}
