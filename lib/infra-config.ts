/**
 * Shared config for the /infra speed dashboard. Pure data — NO server imports —
 * so both the client dashboard (`app/infra/page.tsx`) and the server probe
 * runner (`lib/infra-probes.ts`) import it.
 *
 * A "probe" is one integration we can time. An "action" is a user-facing flow
 * (Send, Cash out, …) mapped to the probes on its critical path — running an
 * action times those probes so you can see where the latency is, per platform.
 */

export type ProbeId =
  | "db"
  | "sui"
  | "onara"
  | "fx"
  | "prover"
  | "linq"
  | "stripe";

export const PROBE_META: { id: ProbeId; label: string }[] = [
  { id: "db", label: "Database (Postgres)" },
  { id: "sui", label: "Sui RPC (Hayabusa)" },
  { id: "onara", label: "Onara gas sponsor" },
  { id: "fx", label: "FX rate feed" },
  { id: "prover", label: "zkLogin prover (Shinami)" },
  { id: "linq", label: "Linq off-ramp" },
  { id: "stripe", label: "Stripe on-ramp" },
];

export type ActionDef = {
  id: string;
  label: string;
  desc: string;
  /** Probes on this action's critical path (timed when you run the action). */
  checks: ProbeId[];
};

/** Web-app actions (the Next.js wallet at /app). */
export const WEB_ACTIONS: ActionDef[] = [
  { id: "home", label: "Home / balances", desc: "Load balance + recent activity", checks: ["db", "sui"] },
  { id: "send", label: "Send", desc: "Gasless USDsui transfer", checks: ["sui", "onara", "db"] },
  { id: "receive", label: "Receive / request", desc: "Resolve @handle + balance", checks: ["db", "sui"] },
  { id: "scan", label: "Scan-to-Pay", desc: "Resolve code → gasless pay", checks: ["sui", "onara", "db"] },
  { id: "cheque", label: "Cheque (money-link)", desc: "Escrow + share link", checks: ["onara", "sui", "db"] },
  { id: "stream", label: "Stream / payroll", desc: "Fund a streamed payout", checks: ["onara", "sui", "db"] },
  { id: "earn", label: "Spend & Save / Earn", desc: "Supply to NAVI yield", checks: ["sui", "db"] },
  { id: "offramp", label: "Cash out (off-ramp)", desc: "USDsui → NGN via Linq", checks: ["fx", "linq", "sui", "db"] },
  { id: "onramp", label: "Add money (on-ramp)", desc: "Card → USDsui via Stripe", checks: ["stripe", "db"] },
];

/** Mobile-app actions (iOS). Same backend; adds onboarding + App Attest. */
export const MOBILE_ACTIONS: ActionDef[] = [
  { id: "onboard", label: "Onboarding (zkLogin)", desc: "Google sign-in + proof warmup", checks: ["prover", "db"] },
  { id: "attest", label: "App Attest", desc: "Challenge + assertion", checks: ["db"] },
  { id: "home", label: "Home / balances", desc: "Snapshot + live balance", checks: ["db", "sui"] },
  { id: "send", label: "Send", desc: "Gasless USDsui transfer", checks: ["sui", "onara", "db"] },
  { id: "scan", label: "Scan-to-Pay", desc: "Resolve code → gasless pay", checks: ["sui", "onara", "db"] },
  { id: "cheque", label: "Cheque (money-link)", desc: "Escrow + share link", checks: ["onara", "sui", "db"] },
  { id: "stream", label: "Stream / payroll", desc: "Fund a streamed payout", checks: ["onara", "sui", "db"] },
  { id: "offramp", label: "Withdraw (off-ramp)", desc: "USDsui → NGN via Linq", checks: ["fx", "linq", "sui", "db"] },
  { id: "onramp", label: "Deposit (on-ramp)", desc: "Card → USDsui via Stripe", checks: ["stripe", "db"] },
];

/** Latency thresholds (ms) for the UI colour bands. */
export const FAST_MS = 300;
export const OK_MS = 1000;
