"use client";

/**
 * Display-currency context. USDsui is always 1:1 USD under the hood; the
 * currency picker ONLY changes how an amount is rendered — it never touches
 * the send/limit/settlement paths. Rates load from /api/fx (USD base); the
 * chosen currency persists in localStorage.
 *
 * Formatting mirrors the iOS `TaliseFormat` rules: "smart" decimals by
 * default (whole numbers show no cents; sub-unit amounts show enough
 * precision to be meaningful) with an opt-in `fixed` 2-decimal mode for
 * ledger-style alignment.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type CurrencyDef = { code: string; symbol: string; label: string };

// The 13 display currencies, in the order the picker shows them.
export const CURRENCIES: CurrencyDef[] = [
  { code: "USD", symbol: "$", label: "US Dollar" },
  { code: "NGN", symbol: "₦", label: "Nigerian Naira" },
  { code: "GHS", symbol: "₵", label: "Ghanaian Cedi" },
  { code: "KES", symbol: "KSh", label: "Kenyan Shilling" },
  { code: "EUR", symbol: "€", label: "Euro" },
  { code: "GBP", symbol: "£", label: "British Pound" },
  { code: "CAD", symbol: "CA$", label: "Canadian Dollar" },
  { code: "ZAR", symbol: "R", label: "South African Rand" },
  { code: "JPY", symbol: "¥", label: "Japanese Yen" },
  { code: "SGD", symbol: "S$", label: "Singapore Dollar" },
  { code: "PHP", symbol: "₱", label: "Philippine Peso" },
  { code: "IDR", symbol: "Rp", label: "Indonesian Rupiah" },
  { code: "VND", symbol: "₫", label: "Vietnamese Dong" },
];

const STORAGE_KEY = "talise:display-currency";
const FX_CACHE_KEY = "talise:fx-cache";

type FxResponse = { base: string; rates: Record<string, number> };

export type CurrencyCtx = {
  currency: string;
  setCurrency: (c: string) => void;
  symbol: string;
  rate: number;
  /** Format a USD amount in the active display currency (smart decimals by default). */
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  /** Alias for formatUsd — converts the USD value into the local currency string. */
  formatLocal: (usd: number, o?: { fixed?: boolean }) => string;
  /** USD → local numeric value (no symbol). */
  toLocal: (usd: number) => number;
  /** Local-per-USD rate for ANY supported currency code (1 if unknown). */
  rateFor: (code: string) => number;
  /** Convert an amount typed in `code` back to USD (e.g. invoice entry). */
  toUsd: (amount: number, code: string) => number;
  currencies: CurrencyDef[];
};

const Ctx = createContext<CurrencyCtx | null>(null);

function defFor(code: string): CurrencyDef {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

// Currencies conventionally shown with no decimal places.
const ZERO_DECIMAL = new Set(["JPY", "VND", "IDR"]);

function formatNumber(
  value: number,
  code: string,
  symbol: string,
  fixed: boolean
): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const zeroDec = ZERO_DECIMAL.has(code);

  let decimals: number;
  if (fixed) {
    decimals = zeroDec ? 0 : 2;
  } else if (zeroDec) {
    decimals = 0;
  } else if (abs > 0 && abs < 1) {
    // Sub-unit: keep enough precision to be meaningful (e.g. $0.05, $0.004).
    decimals = abs >= 0.1 ? 2 : abs >= 0.01 ? 3 : 4;
  } else if (abs >= 100000) {
    // Big balances read cleaner without trailing cents.
    decimals = 0;
  } else {
    // Smart: drop the cents on whole numbers, keep them otherwise.
    decimals = Number.isInteger(abs) ? 0 : 2;
  }

  const num = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${sign}${symbol}${num}`;
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<string>("USD");
  const [rates, setRates] = useState<Record<string, number>>({ USD: 1 });

  // Hydrate the saved choice + cached rates before paint where possible.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && CURRENCIES.some((c) => c.code === saved)) setCurrencyState(saved);
      const cached = localStorage.getItem(FX_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { rates?: Record<string, number> };
        if (parsed?.rates) setRates({ USD: 1, ...parsed.rates });
      }
    } catch {
      /* storage blocked — defaults are fine */
    }
  }, []);

  // Load live FX rates once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fx", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as FxResponse;
        if (cancelled || !data?.rates) return;
        const next = { USD: 1, ...data.rates };
        setRates(next);
        try {
          localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rates: next }));
        } catch {
          /* ignore */
        }
      } catch {
        /* keep cached / USD-only */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrency = useCallback((c: string) => {
    if (!CURRENCIES.some((x) => x.code === c)) return;
    setCurrencyState(c);
    try {
      localStorage.setItem(STORAGE_KEY, c);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<CurrencyCtx>(() => {
    const def = defFor(currency);
    // Fall back to a 1:1 rate (USD display) if the chosen rate is missing —
    // the UI never shows a broken/NaN amount.
    const rate = rates[currency] && rates[currency] > 0 ? rates[currency] : 1;
    const symbol = rate === 1 && currency !== "USD" ? "$" : def.symbol;
    const code = rate === 1 && currency !== "USD" ? "USD" : currency;

    const toLocal = (usd: number) => usd * rate;
    const rateFor = (c: string) => (rates[c] && rates[c] > 0 ? rates[c] : 1);
    const toUsd = (amount: number, c: string) => amount / rateFor(c);
    const formatUsd = (usd: number, o?: { fixed?: boolean }) =>
      formatNumber(usd * rate, code, symbol, o?.fixed ?? false);

    return {
      currency,
      setCurrency,
      symbol,
      rate,
      formatUsd,
      formatLocal: formatUsd,
      toLocal,
      rateFor,
      toUsd,
      currencies: CURRENCIES,
    };
  }, [currency, rates, setCurrency]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrency(): CurrencyCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useCurrency must be used within <CurrencyProvider> (mounted by AppShell)");
  }
  return ctx;
}
