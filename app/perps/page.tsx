import { PerpsFlow } from "@/components/app/markets/PerpsFlow";

export const dynamic = "force-dynamic";

/**
 * /perps, the dedicated Talise Perps surface (served at perps.talise.io via
 * middleware host-routing). The guided conviction flow (Market → Direction →
 * Size → Launch) on the same audited WaterX rails as the /app/markets terminal.
 */
export default function PerpsPage() {
  return <PerpsFlow />;
}
