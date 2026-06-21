import { redirect } from "next/navigation";

/**
 * Rewards moved to its own top-level surface at /app/rewards (the points
 * hub, mirroring iOS). Keep this route as a redirect so old links and
 * bookmarks still land in the right place.
 */
export default function LegacyRewardsRedirect() {
  redirect("/app/rewards");
}
