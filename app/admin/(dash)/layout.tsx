import { redirect } from "next/navigation";
import { resolveAdmin } from "@/lib/admin-auth";
import { AdminShell } from "../_components/shell";

export const dynamic = "force-dynamic";

/**
 * Gate for every dashboard page. Resolves the admin context (dev-open /
 * token cookie / allowlisted session); unauthenticated visitors are
 * bounced to /admin/login (which lives OUTSIDE this route group, so it
 * isn't itself gated).
 */
export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const ctx = await resolveAdmin();
  if (!ctx) redirect("/admin/login");
  return <AdminShell via={ctx.via}>{children}</AdminShell>;
}
