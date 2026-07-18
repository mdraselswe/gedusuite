import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { buildReport, parseRange } from "@/lib/reports";
import { ReportView } from "@/components/reports/report-view";

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { workspace: slug } = await params;
  const { from, to } = await searchParams;

  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "reports", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const range = parseRange(from, to);
  const report = await buildReport(access.workspaceId, range);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold">Reports</h1>
      <ReportView
        slug={slug}
        report={report}
        from={range.from.toISOString().slice(0, 10)}
        to={range.to.toISOString().slice(0, 10)}
      />
    </div>
  );
}
