import { ActivityScreen } from "@/components/app/activity/ActivityScreen";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Activity · Talise",
};

/**
 * /app/activity, full transaction history. The AppShell (from the /app
 * layout) provides the responsive chrome; this page renders the activity
 * feature screen inside it.
 */
export default function ActivityPage() {
  return <ActivityScreen />;
}
