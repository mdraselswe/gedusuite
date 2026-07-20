import { requireMembership, serverT } from "@/lib/session";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeInventoryAlerts } from "@/lib/inventory";
import { overdueOrders, totalBusinessProfit, treasuryBalance } from "@/lib/finance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { LayoutDashboard, Users, Wallet, UserCog } from "lucide-react";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { membership } = await requireMembership(slug);
  const workspaceId = membership.workspaceId;
  const t = await serverT();

  const access = await workspaceAccess(slug);
  const canViewPartners =
    !!access && can(access.role, "partners", "view", access.permissions);
  const canViewTreasury =
    !!access && can(access.role, "treasury", "view", access.permissions);

  // Read-only computes — the dashboard must not write to the DB on every view.
  // Notification reconciliation happens on mutations + the scheduled cron.
  const [memberCount, alerts, overdue, profit, treasury] = await Promise.all([
    prisma.membership.count({ where: { workspaceId } }),
    computeInventoryAlerts(workspaceId),
    overdueOrders(workspaceId),
    totalBusinessProfit(workspaceId),
    treasuryBalance(workspaceId),
  ]);

  const lowStock = alerts.filter((a) => a.type === "LOW_STOCK");
  const expiring = alerts.filter((a) => a.type === "EXPIRY");
  const totalOverdue = overdue.reduce((s, o) => s + o.amount, 0);

  // Partner profit-share breakdown (only for those who can view partners).
  let partnerShares: { name: string; percent: number; amount: number }[] = [];
  if (canViewPartners) {
    const partners = await prisma.partner.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
    });
    // If the viewer is a plain PARTNER, only show their own share.
    const scoped =
      access?.role === "PARTNER"
        ? partners.filter((p) => p.userId === access.userId)
        : partners;
    partnerShares = scoped.map((p) => {
      const percent = Number(p.profitSharePercent);
      return {
        name: p.user.name ?? p.user.email,
        percent,
        amount: Math.round((percent / 100) * profit * 100) / 100,
      };
    });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader icon={<LayoutDashboard />} color="blue" title={t("dashboard")} />

      {(alerts.length > 0 || overdue.length > 0) && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <div className="font-semibold text-amber-800 dark:text-amber-300">
            {lowStock.length} low-stock · {expiring.length} expiring soon ·{" "}
            {overdue.length} overdue payment(s)
            {totalOverdue > 0 && ` (${totalOverdue.toFixed(2)})`}
          </div>
          <ul className="list-inside list-disc text-amber-900/90 dark:text-amber-200/90">
            {alerts.slice(0, 5).map((a) => (
              <li key={a.dedupeKey}>{a.message}</li>
            ))}
            {overdue.slice(0, 3).map((o) => (
              <li key={o.orderId}>
                Overdue: {o.customerName} owes {o.amount.toFixed(2)} ({o.daysOverdue}d)
                {o.heldByName ? ` — held by ${o.heldByName}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
          <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-500/10 text-slate-600 dark:text-slate-400">
              <UserCog className="size-4" />
            </span>
            <CardTitle className="text-sm font-medium text-muted-foreground">Your role</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{membership.role}</CardContent>
        </Card>
        <Card className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 delay-75">
          <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-pink-500/10 text-pink-600 dark:text-pink-400">
              <Users className="size-4" />
            </span>
            <CardTitle className="text-sm font-medium text-muted-foreground">Team members</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{memberCount}</CardContent>
        </Card>
        {canViewTreasury && (
          <Card className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 delay-150">
            <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <Wallet className="size-4" />
              </span>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Treasury balance
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{treasury.toFixed(2)}</CardContent>
          </Card>
        )}
      </div>

      {canViewPartners && partnerShares.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Partner profit share — total profit {profit.toFixed(2)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={partnerShares}
              rowKey={(p) => p.name}
              empty={{ icon: Users, title: "No partners" }}
              columns={
                [
                  { key: "name", header: "Partner", cardTitle: true, cell: (p) => p.name },
                  {
                    key: "percent",
                    header: "Share %",
                    align: "right",
                    cell: (p) => p.percent.toFixed(2),
                  },
                  {
                    key: "amount",
                    header: "Share amount",
                    align: "right",
                    cell: (p) => p.amount.toFixed(2),
                  },
                ] as Column<(typeof partnerShares)[number]>[]
              }
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
