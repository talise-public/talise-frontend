import { redirect } from "next/navigation";
import { readSessionEntryId } from "@/lib/session";
import { userById, isAppAccessAllowed } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * /business gate, same private-beta allowlist as /app.
 *
 * Signed-in + allowlisted users get the surface; everyone else is bounced to
 * /app (which renders the sign-in screen or the waiting room as appropriate).
 * This thin gate covers BOTH the landing at /business and the `(workspace)`
 * route group; the workspace's own layout adds AppShell chrome + session.
 */
export default async function BusinessGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const id = await readSessionEntryId();
  const u = id != null ? await userById(id).catch(() => null) : null;
  if (!u || !(await isAppAccessAllowed(u.email))) {
    redirect("/app");
  }
  return <>{children}</>;
}
