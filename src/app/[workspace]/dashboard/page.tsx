import Link from "next/link";
import { requireMembership, serverT } from "@/lib/session";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeInventoryAlerts } from "@/lib/inventory";
import { overdueOrders, totalBusinessProfit, treasuryBalance } from "@/lib/finance";
import { splitByShare } from "@/lib/profit-share";
import { dhakaDayStart, dhakaMonthStart } from "@/lib/dhaka-time";
import { computeOrderTotals, orderNetProfit } from "@/lib/orders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerShareTable } from "@/components/dashboard/partner-share-table";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { Money } from "@/components/ui/money";
import { toneForBalance } from "@/lib/money";
import {
  LayoutDashboard,
  Users,
  Wallet,
  Megaphone,
  Receipt,
  TrendingUp,
  AlertTriangle,
  Plus,
  BarChart3,
  ArrowRight,
} from "lucide-react";


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
  const canViewBoosting =
    !!access && can(access.role, "boosting", "view", access.permissions);
  // Month sales/profit follow the reports gate — STAFF adds orders but doesn't
  // see business-level revenue numbers.
  const canViewReports =
    !!access && can(access.role, "reports", "view", access.permissions);
  const canAddSales = !!access && can(access.role, "sales", "add", access.permissions);
  const canAddBoost = !!access && can(access.role, "boosting", "add", access.permissions);

  // Read-only computes — the dashboard must not write to the DB on every view.
  // Notification reconciliation happens on mutations + the scheduled cron.
  // The month starts at midnight in Dhaka, not in UTC — six hours earlier, and
  // enough to push the first night's orders into the previous month.
  const monthStart = dhakaDayStart(dhakaMonthStart());
  const [memberCount, alerts, overdue, profit, treasury, adSpendAgg, monthOrders, partners] =
    await Promise.all([
      prisma.membership.count({ where: { workspaceId } }),
      computeInventoryAlerts(workspaceId),
      overdueOrders(workspaceId),
      totalBusinessProfit(workspaceId),
      treasuryBalance(workspaceId),
      prisma.boostDailySpend.aggregate({
        _sum: { amount: true },
        where: { workspaceId, date: { gte: monthStart } },
      }),
      canViewReports
        ? prisma.order.findMany({
            // Cancelled orders included on purpose: they sell nothing but
            // their packaging and courier charges come off this month's
            // profit, the same as on the reports page.
            where: { workspaceId, date: { gte: monthStart } },
            include: { items: { include: { returns: true } } },
          })
        : Promise.resolve([]),
      // Was a sequential findMany after this Promise.all resolved — one more
      // full round trip tacked onto every dashboard render for no reason.
      canViewPartners
        ? prisma.partner.findMany({
            where: { workspaceId },
            include: { user: { select: { name: true, email: true } } },
          })
        : Promise.resolve([]),
    ]);
  const monthAdSpend = Number(adSpendAgg._sum.amount ?? 0);

  const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  let monthRevenue = 0;
  let monthProfit = 0;
  for (const o of monthOrders) {
    if (o.status === "CANCELLED") {
      monthProfit += orderNetProfit(o);
      continue;
    }
    const totals = computeOrderTotals(o);
    monthRevenue += totals.netRevenue;
    monthProfit += totals.netProfit;
  }
  monthRevenue = round2(monthRevenue);
  monthProfit = round2(monthProfit);

  const lowStock = alerts.filter((a) => a.type === "LOW_STOCK");
  const expiring = alerts.filter((a) => a.type === "EXPIRY");
  const totalOverdue = overdue.reduce((s, o) => s + o.amount, 0);

  // Partner profit-share breakdown (only for those who can view partners).
  let partnerShares: { name: string; percent: number; amount: number }[] = [];
  if (canViewPartners) {
    // If the viewer is a plain PARTNER, only show their own share.
    const scoped =
      access?.role === "PARTNER"
        ? partners.filter((p) => p.userId === access.userId)
        : partners;
    // Split across EVERY partner, then narrowed to the viewer: a plain PARTNER
    // seeing only their own row must still be paid out of the same whole, or
    // their share would be normalized against themselves and read as 100%.
    const cuts = splitByShare(
      partners.map((p) => ({
        userId: p.userId,
        name: p.user.name ?? p.user.email,
        percent: Number(p.profitSharePercent),
      })),
      // What is left to hand out, not the lifetime total. Splitting netProfit
      // showed a partner the same "your share" every month however much of it
      // they had already been paid — a figure that only ever went up, for money
      // that had already left.
      profit.distributableProfit,
    );
    const visible = new Set(scoped.map((p) => p.userId));
    partnerShares = cuts
      .filter((c) => visible.has(c.userId))
      .map((c) => ({ name: c.name, percent: c.effectivePercent, amount: c.amount }));
  }

  const quickActions = [
    canAddSales && { href: `/${slug}/sales/orders`, label: "New order", icon: <Plus className="size-4" /> },
    canAddBoost && { href: `/${slug}/boosting`, label: "Add boost spend", icon: <Megaphone className="size-4" /> },
    canViewTreasury && { href: `/${slug}/treasury`, label: "Treasury", icon: <Wallet className="size-4" /> },
    canViewReports && { href: `/${slug}/reports`, label: "Reports", icon: <BarChart3 className="size-4" /> },
  ].filter(Boolean) as { href: string; label: string; icon: React.ReactNode }[];

  let delay = 0;
  const nextDelay = () => (delay += 60);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<LayoutDashboard />}
        color="blue"
        title={t("dashboard")}
        action={
          <span className="text-sm text-muted-foreground">
            {memberCount} member{memberCount === 1 ? "" : "s"} · you are{" "}
            <span className="font-medium text-foreground">{membership.role}</span>
          </span>
        }
      />

      {quickActions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {quickActions.map((a) => (
            <Link
              key={a.href + a.label}
              href={a.href}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {a.icon} {a.label}
            </Link>
          ))}
        </div>
      )}

      {(alerts.length > 0 || overdue.length > 0) && (
        <div className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both flex gap-3 rounded-xl border border-amber-300/70 bg-amber-50 p-4 text-sm duration-300 dark:border-amber-800 dark:bg-amber-950/40">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <div className="font-semibold text-amber-800 dark:text-amber-300">
              {lowStock.length} low-stock · {expiring.length} expiring soon ·{" "}
              {overdue.length} overdue payment(s)
              {totalOverdue > 0 && <> (<Money value={totalOverdue} />)</>}
            </div>
            <ul className="list-inside list-disc text-amber-900/90 dark:text-amber-200/90">
              {alerts.slice(0, 5).map((a) => (
                <li key={a.dedupeKey}>{a.message}</li>
              ))}
              {overdue.slice(0, 3).map((o) => (
                <li key={o.orderId}>
                  Overdue: {o.customerName} owes <Money value={o.amount} /> ({o.daysOverdue}d)
                  {o.heldByName ? ` — held by ${o.heldByName}` : ""}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <StatGrid>
        {canViewReports && (
          <StatTile
            icon={<Receipt />}
            color="emerald"
            label="Sales this month"
            value={monthRevenue}
            sub={`${monthOrders.length} order${monthOrders.length === 1 ? "" : "s"}`}
            href={`/${slug}/sales/orders`}
          />
        )}
        {canViewReports && (
          <StatTile
            icon={<TrendingUp />}
            color="teal"
            label="Profit this month"
            value={monthProfit}
            tone={toneForBalance(monthProfit)}
            href={`/${slug}/reports`}
          />
        )}
        {canViewTreasury && (
          <StatTile
            icon={<Wallet />}
            color="amber"
            label="Treasury balance"
            value={treasury}
            tone={toneForBalance(treasury)}
            href={`/${slug}/treasury`}
          />
        )}
        {canViewBoosting && (
          <StatTile
            icon={<Megaphone />}
            color="sky"
            label="Ad spend this month"
            value={monthAdSpend}
            href={`/${slug}/boosting`}
          />
        )}
        {!canViewReports && (
          <StatTile
            icon={<Users />}
            color="pink"
            label="Team members"
            value={String(memberCount)}
          />
        )}
      </StatGrid>

      {canViewPartners && partnerShares.length > 0 && (
        <Card className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-300 delay-300">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">
              Partner profit share — <Money value={profit.distributableProfit} /> still
              to distribute
              {profit.distributed > 0 && (
                <span className="ml-1 font-normal text-muted-foreground">
                  (earned <Money value={profit.netProfit} />, paid out{" "}
                  <Money value={profit.distributed} />)
                </span>
              )}
            </CardTitle>
            <Link
              href={`/${slug}/partners`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Partners <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            <PartnerShareTable rows={partnerShares} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
