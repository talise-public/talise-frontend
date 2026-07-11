/**
 * Parser for the agent's `---INTENT---` blocks.
 *
 * The agent emits one JSON line wrapped in delimiters, sometimes with
 * conversational text before it. We extract the JSON, validate the shape,
 * and let the UI / executor decide what to do.
 *
 * Shape:
 *   ---INTENT---
 *   {"steps":[{"kind":"send","amount":50,"recipient":"alice.talise"}]}
 *   ---END---
 */

export type YieldVenueId = "navi" | "deepbook";

/**
 * `localAmount` + `localCurrency` carry the amount the user actually said in
 * their own currency ("1000 naira"). When present, the server computes the
 * EXACT usd ( = localAmount / Talise rate ) at full precision, so the value
 * round-trips back to ~₦1000 instead of drifting from a cents-rounded `amount`.
 * `amount` (usd) stays as the agent's estimate / fallback.
 */
type LocalAmount = { localAmount?: number; localCurrency?: string };

export type ChatStep =
  | ({ kind: "send"; amount: number; recipient: string } & LocalAmount)
  | { kind: "swap"; from: "USDsui" | "SUI"; to: "USDsui" | "SUI"; amount: number }
  | ({ kind: "save"; amount: number; venue?: YieldVenueId } & LocalAmount)
  | ({ kind: "withdraw"; amount: number; venue?: YieldVenueId } & LocalAmount)
  | { kind: "claim_rewards" }
  | ({ kind: "cash_out"; amount: number } & LocalAmount)
  | ({ kind: "request"; amount: number; note?: string } & LocalAmount)
  | { kind: "check_balance" }
  | { kind: "check_yield" }
  | { kind: "show_activity"; limit?: number };

export type ChatIntent = {
  steps: ChatStep[];
  rationale?: string;
};

const FENCE = /---INTENT---\s*([\s\S]*?)\s*---END---/m;

/**
 * Split a raw assistant message into (text, intent | null). The text is
 * the conversational prefix shown to the user; the intent (if present)
 * is what the UI uses to render a confirm card / execute the action.
 */
export function parseAssistantMessage(raw: string): {
  text: string;
  intent: ChatIntent | null;
} {
  const m = raw.match(FENCE);
  if (!m) return { text: raw.trim(), intent: null };

  const before = raw.slice(0, m.index).trim();
  let intent: ChatIntent | null = null;
  try {
    const parsed = JSON.parse(m[1].trim()) as { steps?: unknown[]; rationale?: string };
    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
      intent = {
        steps: parsed.steps as ChatStep[],
        rationale: parsed.rationale,
      };
    }
  } catch {
    /* malformed JSON → leave intent null, fall through */
  }

  return { text: before, intent };
}

/** Stable user-facing label for a step — used in confirm UI. */
export function stepLabel(step: ChatStep): string {
  switch (step.kind) {
    case "send":
      return `Send $${step.amount.toFixed(2)} → ${step.recipient}`;
    case "swap":
      return `Swap ${step.amount} ${step.from} → ${step.to}`;
    case "save": {
      const venueName =
        step.venue === "deepbook" ? "DeepBook margin" : "NAVI";
      return `Save $${step.amount.toFixed(2)} into ${venueName}`;
    }
    case "withdraw": {
      const venueName =
        step.venue === "deepbook" ? "DeepBook margin" : "NAVI";
      return `Withdraw $${step.amount.toFixed(2)} from ${venueName}`;
    }
    case "claim_rewards":
      return "Claim rewards";
    case "cash_out":
      return `Cash out $${step.amount.toFixed(2)} to your bank`;
    case "request":
      return `Request $${step.amount.toFixed(2)}${step.note ? ` for ${step.note}` : ""}`;
    case "check_balance":
      return "Show balance";
    case "check_yield":
      return "Show yield";
    case "show_activity":
      return `Show last ${step.limit ?? 8} payments`;
  }
}

/**
 * Read-only steps don't need a signature — the UI can run them inline
 * (e.g. by re-rendering the dashboard) instead of opening a confirm card.
 */
export function isReadOnly(step: ChatStep): boolean {
  return (
    step.kind === "check_balance" ||
    step.kind === "check_yield" ||
    step.kind === "show_activity"
  );
}
