/**
 * USDsui, the Sui-native USD stable we settle everything into.
 *
 * The constant below is the literal value of `USDSUI_TYPE` exported by
 * `@t2000/sdk` (mirrors `COIN_REGISTRY.USDsui.type`). We hardcode it here
 * instead of importing from the SDK so this module can be safely included
 * by client bundles, the SDK is server-only.
 */
export const USDSUI_TYPE =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

export const USDSUI_SYMBOL = "USDsui";

/**
 * Strip the `0x` prefix and lowercase the address part so comparisons aren't
 * thrown off by case or short-form addresses. Sui type strings are
 * `<addr>::<module>::<name>`, only the address portion is hex-canonicalized,
 * the module/name segments are case-sensitive identifiers.
 */
function normalizeCoinType(t: string): string {
  const parts = t.split("::");
  if (parts.length !== 3) return t.toLowerCase();
  const addr = parts[0].toLowerCase().replace(/^0x/, "");
  return `0x${addr}::${parts[1]}::${parts[2]}`;
}

const USDSUI_NORMALIZED = normalizeCoinType(USDSUI_TYPE);

export function isUsdsui(coinType: string): boolean {
  return normalizeCoinType(coinType) === USDSUI_NORMALIZED;
}
