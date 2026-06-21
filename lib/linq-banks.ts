/**
 * Nigerian bank registry for the Linq off-ramp.
 *
 * Vendored from the Linq docs (`nigerian-banks.json`). Linq's API takes the
 * plain NIBSS `bankCode` directly (no per-bank UUID like Paga required), so
 * this is just a code↔name list for the picker + a server-side name lookup
 * when the client doesn't pass `bankName`.
 */

export interface LinqBank {
  name: string;
  bankCode: string;
}

export const LINQ_BANKS: readonly LinqBank[] = [
  { name: "Access Bank", bankCode: "044" },
  { name: "Diamond Bank", bankCode: "063" },
  { name: "Fidelity Bank", bankCode: "070" },
  { name: "FCMB", bankCode: "214" },
  { name: "First Bank Of Nigeria", bankCode: "011" },
  { name: "Guaranty Trust Bank", bankCode: "058" },
  { name: "Polaris Bank", bankCode: "076" },
  { name: "Union Bank", bankCode: "032" },
  { name: "United Bank for Africa", bankCode: "033" },
  { name: "Citibank", bankCode: "023" },
  { name: "Ecobank Bank", bankCode: "050" },
  { name: "Heritage", bankCode: "030" },
  { name: "Keystone Bank", bankCode: "082" },
  { name: "Stanbic IBTC Bank", bankCode: "039" },
  { name: "Standard Chartered Bank", bankCode: "068" },
  { name: "Sterling Bank", bankCode: "232" },
  { name: "Unity Bank", bankCode: "215" },
  { name: "Suntrust Bank", bankCode: "100" },
  { name: "Providus Bank", bankCode: "101" },
  { name: "FBNQuest Merchant Bank", bankCode: "060002" },
  { name: "Greenwich Merchant Bank", bankCode: "060004" },
  { name: "FSDH Merchant Bank", bankCode: "501" },
  { name: "Rand Merchant Bank", bankCode: "502" },
  { name: "Jaiz Bank", bankCode: "301" },
  { name: "Zenith Bank", bankCode: "057" },
  { name: "Wema Bank", bankCode: "035" },
  { name: "Kuda Microfinance Bank", bankCode: "090267" },
  { name: "OPay", bankCode: "100004" },
  { name: "PalmPay", bankCode: "100033" },
  { name: "Paystack-Titan MFB", bankCode: "100039" },
  { name: "Moniepoint MFB", bankCode: "090405" },
  { name: "Safe Haven MFB", bankCode: "090286" },
];

const BY_CODE = new Map(LINQ_BANKS.map((b) => [b.bankCode, b]));

/** Resolve a bank by its NIBSS code, or null if unknown. */
export function resolveLinqBank(bankCode: string): LinqBank | null {
  return BY_CODE.get(bankCode.trim()) ?? null;
}

// Bank codes we have a brand logo for (vendored SVGs in /public/bank-logos,
// from github.com/Pariola-droid/Nigerian-Bank-Logos). Others fall back to a
// letter avatar in the picker.
const LOGO_CODES = new Set([
  "011", // First Bank
  "033", // UBA
  "035", // Wema
  "039", // Stanbic IBTC
  "044", // Access
  "050", // Ecobank
  "057", // Zenith
  "058", // GTBank
  "070", // Fidelity
  "214", // FCMB
  "215", // Unity
  "232", // Sterling
  "301", // Jaiz
]);

/** Path to a bank's logo SVG, or null if we don't have one. */
export function bankLogo(bankCode: string): string | null {
  return LOGO_CODES.has(bankCode) ? `/bank-logos/${bankCode}.svg` : null;
}
