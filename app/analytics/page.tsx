// The old public live-metrics page at /analytics went stale. /analytics now
// serves the same content as /dashboard-analytics (the real network dashboard:
// users, stablecoin volume, live tx feed) — admin-gated, identical chrome.
// Re-exported so dashboard-analytics/ stays the single source of truth.
export { default, dynamic } from "../dashboard-analytics/page";

export const metadata = {
  title: "Talise — network analytics",
};
