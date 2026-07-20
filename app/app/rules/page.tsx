import { RulesView } from "@/components/app/rules/RulesView";

/**
 * /app/rules, programmable money / automations.
 *
 * Scheduled sends drawn from a NON-CUSTODIAL on-chain pot the user owns (a
 * `standing_order` funded up front; refundable on cancel). Gated server-side
 * until the automations engine is configured; when off (`enabled === false`),
 * RulesView renders a clean "coming soon" state. All client-side, talking to
 * /api/rules.
 */
export default function RulesPage() {
  return <RulesView />;
}
