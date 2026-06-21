/**
 * Amount-in-words, cheque convention: "One hundred and 50/100".
 * Mirrors the iOS `amountInWords` so issued cheques read identically
 * across web and native.
 */

const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

function under1000(x: number): string {
  const parts: string[] = [];
  const h = Math.floor(x / 100);
  const r = x % 100;
  if (h > 0) parts.push(`${ONES[h]} hundred`);
  if (r >= 20) {
    const t = TENS[Math.floor(r / 10)];
    const o = r % 10;
    parts.push(o > 0 ? `${t}-${ONES[o]}` : t);
  } else if (r > 0) {
    parts.push(ONES[r]);
  }
  return parts.join(" ");
}

function numberToWords(n: number): string {
  if (n === 0) return "zero";
  const out: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor(n / 1000) % 1000;
  const rest = n % 1000;
  if (millions > 0) out.push(`${under1000(millions)} million`);
  if (thousands > 0) out.push(`${under1000(thousands)} thousand`);
  if (rest > 0) out.push(under1000(rest));
  return out.join(" ");
}

export function amountInWords(usd: number): string {
  const whole = Math.floor(usd);
  const cents = Math.round((usd - whole) * 100);
  const dollars = whole === 0 ? "Zero" : numberToWords(whole);
  const centStr = String(cents).padStart(2, "0");
  const phrase = `${dollars} and ${centStr}/100`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
