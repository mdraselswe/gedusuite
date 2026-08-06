import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { parseRange } from "@/lib/reports";
import { buildProductReport } from "@/lib/product-report";
import { ProductDetailView } from "@/components/products/product-detail-view";

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ from?: string; to?: string; range?: string }>;
}) {
  const { workspace: slug, id } = await params;
  const { from, to, range: rangeParam } = await searchParams;

  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "products", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  // Cost and profit are reports-gated everywhere else in the app (order
  // breakdown, customer detail, the orders list' Profit column) — this page
  // is the same data per product, so it obeys the same gate.
  const canViewProfit = can(access.role, "reports", "view", access.permissions);

  // Unlike the reports page this one defaults to ALL TIME: "how much has this
  // product made" is a lifetime question, and a silent 30-day window would
  // quietly answer a different one. A from/to in the URL narrows it.
  const isAllTime = rangeParam === "all" || (!from && !to);
  const dateRange = parseRange(from, to);
  const report = await buildProductReport(
    access.workspaceId,
    id,
    isAllTime ? null : dateRange,
  );
  if (!report) notFound();

  return (
    <ProductDetailView
      slug={slug}
      report={report}
      canViewProfit={canViewProfit}
      from={dateRange.from.toISOString().slice(0, 10)}
      to={dateRange.to.toISOString().slice(0, 10)}
      isAllTime={isAllTime}
    />
  );
}
