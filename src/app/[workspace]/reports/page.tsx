import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { buildReport, parseRange } from "@/lib/reports";
import { ReportView } from "@/components/reports/report-view";
import { serverT } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { BarChart3 } from "lucide-react";

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
  const [report, workspace] = await Promise.all([
    buildReport(access.workspaceId, range),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader icon={<BarChart3 />} color="teal" title={(await serverT())("reports")} />
      <ReportView
        slug={slug}
        report={report}
        from={range.from.toISOString().slice(0, 10)}
        to={range.to.toISOString().slice(0, 10)}
        workspaceName={workspace?.name ?? "Report"}
        logoUrl={workspace?.logoUrl ?? null}
      />
    </div>
  );
}
