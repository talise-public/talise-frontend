/** Short-format a Sui address as `0xabcd…1234` for chrome / display. */
export function shortAddress(address: string, prefix = 6, suffix = 4): string {
  if (!address) return "";
  const a = address.startsWith("0x") ? address : `0x${address}`;
  if (a.length <= prefix + suffix + 3) return a;
  return `${a.slice(0, prefix + 2)}…${a.slice(-suffix)}`;
}

/** Short-format a transaction digest (Base58, ~44 chars) the same way. */
export function shortDigest(d: string, prefix = 8, suffix = 6): string {
  if (!d) return "";
  if (d.length <= prefix + suffix + 3) return d;
  return `${d.slice(0, prefix)}…${d.slice(-suffix)}`;
}
