import Link from "next/link";
import { redirect } from "next/navigation";
import { PhoneCall } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { dhakaDayKey, dhakaToday } from "@/lib/dhaka-time";
import { round2 } from "@/lib/money";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { CustomerFollowUpManager } from "@/components/customers/customer-follow-up-manager";

export default async function CustomerFollowUpsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "customers", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const customers = await prisma.customer.findMany({
    where: { workspaceId: access.workspaceId, reengageEnabled: true },
    orderBy: [{ reengageNextReachAt: "asc" }, { name: "asc" }],
    include: { orders: { include: { items: { include: { returns: true } } } } },
  });

  const today = dhakaToday();
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const rows = customers.map((c) => {
    const live = c.orders.filter((o) => o.status !== "CANCELLED");
    const nextReachDay = c.reengageNextReachAt ? dhakaDayKey(c.reengageNextReachAt) : null;
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      altPhone: c.altPhone,
      address: c.address,
      note: c.reengageNote,
      lastReachedDay: c.reengageLastReachedAt ? dhakaDayKey(c.reengageLastReachedAt) : null,
      nextReachDay,
      daysUntilNext:
        nextReachDay === null
          ? null
          : Math.round((Date.parse(`${nextReachDay}T00:00:00Z`) - todayTime) / 86_400_000),
      orderCount: live.length,
      lifetime: round2(live.reduce((s, o) => s + computeOrderTotals(o).customerTotal, 0)),
    };
  });
  const dueCount = rows.filter((r) => r.daysUntilNext === null || r.daysUntilNext <= 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<PhoneCall />}
        color="sky"
        title="Customer follow-ups"
        count={rows.length}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {dueCount} due now
            </span>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href={`/${slug}/customers`} />}
            >
              Customers
            </Button>
          </div>
        }
      />
      <CustomerFollowUpManager
        slug={slug}
        rows={rows}
        canEdit={can(access.role, "customers", "edit", access.permissions)}
      />
    </div>
  );
}
