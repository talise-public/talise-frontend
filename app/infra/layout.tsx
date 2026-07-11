import { redirect } from "next/navigation";
import { resolveAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * /infra — internal speed/integration dashboard. Admin-gated like /admin
 * (open in local dev via resolveAdmin's dev-open escape hatch).
 */
export default async function InfraLayout({ children }: { children: React.ReactNode }) {
  if (!(await resolveAdmin())) {
    redirect("/admin/login");
  }
  return <div className="min-h-screen bg-[#0b0d10] text-zinc-100">{children}</div>;
}
