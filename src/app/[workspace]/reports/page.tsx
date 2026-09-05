import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { buildReport, parseRange } from "@/lib/reports";
import { ReportView } from "@/components/reports/report-view";
import { serverT } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { BarChart3 } from "lucide-react";
import { orderRecipient } from "@/lib/order-recipient";
import { formatDhakaDate } from "@/lib/dhaka-time";

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string; range?: string }>;
}) {
  const { workspace: slug } = await params;
  const { from, to, range: rangeParam } = await searchParams;

  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "reports", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  // "All time" ignores the date range entirely instead of computing one —
  // the date inputs below still seed from/to so switching back to a range
  // doesn't lose the user's last pick.
  const isAllTime = rangeParam === "all";
  const dateRange = parseRange(from, to);
  const orderDateWhere = isAllTime
    ? {}
    : { date: { gte: dateRange.from, lte: dateRange.to } };
  const [report, workspace, untaggedOrders] = await Promise.all([
    buildReport(access.workspaceId, isAllTime ? null : dateRange),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true },
    }),
    prisma.order.findMany({
      where: {
        workspaceId: access.workspaceId,
        shipDistrict: null,
        ...orderDateWhere,
      },
      orderBy: { date: "desc" },
      take: 100,
      select: {
        id: true,
        orderNo: true,
        date: true,
        status: true,
        source: true,
        shipName: true,
        shipPhone: true,
        shipAddress: true,
        customer: { select: { name: true, phone: true, address: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader icon={<BarChart3 />} color="teal" title={(await serverT())("reports")} />
      <ReportView
        slug={slug}
        report={report}
        from={dateRange.from.toISOString().slice(0, 10)}
        to={dateRange.to.toISOString().slice(0, 10)}
        isAllTime={isAllTime}
        workspaceName={workspace?.name ?? "Report"}
        logoUrl={workspace?.logoUrl ?? null}
        untaggedOrders={untaggedOrders.map((order) => {
          const to = orderRecipient(order);
          return {
            id: order.id,
            orderNo: order.orderNo != null ? `#${order.orderNo}` : order.id.slice(-8).toUpperCase(),
            date: formatDhakaDate(order.date),
            status: order.status,
            source: order.source,
            recipient: to.name ?? "Walk-in",
            phone: to.phone,
            address: to.address,
          };
        })}
      />
    </div>
  );
}
