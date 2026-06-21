/**
 * Compact relative-time formatter for activity rows. Mirrors the terse,
 * mono-friendly style of the iOS history feed ("now", "5m", "3h", "2d",
 * then an absolute date for anything older than a week).
 */
export function relativeTime(timestampMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestampMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const d = new Date(timestampMs);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
