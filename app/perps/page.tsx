import { PerpsTerminal } from "@/components/app/markets/PerpsTerminal";

export const dynamic = "force-dynamic";

/**
 * /perps, the dedicated Talise Perps surface (served at perps.talise.io via
 * middleware host-routing). Same audited terminal as /app/markets, but with its
 * own focused chrome instead of the full app nav (see ./layout.tsx).
 */
export default function PerpsPage() {
  return <PerpsTerminal />;
}
