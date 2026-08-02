import Link from "next/link";
import { requireMembership, serverT } from "@/lib/session";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeInventoryAlerts } from "@/lib/inventory";
import { overdueOrders, totalBusinessProfit, treasuryBalance } from "@/lib/finance";
import { computeOrderTotals } from "@/lib/orders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerShareTable } from "@/components/dashboard/partner-share-table";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { sectionColorClasses, type SectionColor } from "@/lib/section-colors";
import { cn } from "@/lib/utils";
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

function StatCard({
  icon,
  color,
  label,
  value,
  sub,
  href,
  delay,
}: {
  icon: React.ReactNode;
  color: SectionColor;
  label: string;
  value: string;
  sub?: string;
  href?: string;
  delay: number;
}) {
  const body = (
    <Card
      className={cn(
        "animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both gap-3 duration-300",
        href && "transition-all hover:border-primary/40 hover:shadow-md hover:shadow-primary/5",
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-0">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl [&_svg]:size-4",
            sectionColorClasses[color],
          )}
        >
          {icon}
        </span>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

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
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
            where: { workspaceId, status: { not: "CANCELLED" }, date: { gte: monthStart } },
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
    partnerShares = scoped.map((p) => {
      const percent = Number(p.profitSharePercent);
      return {
        name: p.user.name ?? p.user.email,
        percent,
        amount: Math.round((percent / 100) * profit * 100) / 100,
      };
    });
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
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {canViewReports && (
          <StatCard
            icon={<Receipt />}
            color="emerald"
            label="Sales this month"
            value={monthRevenue.toFixed(2)}
            sub={`${monthOrders.length} order${monthOrders.length === 1 ? "" : "s"}`}
            href={`/${slug}/sales/orders`}
            delay={nextDelay()}
          />
        )}
        {canViewReports && (
          <StatCard
            icon={<TrendingUp />}
            color="teal"
            label="Profit this month"
            value={monthProfit.toFixed(2)}
            href={`/${slug}/reports`}
            delay={nextDelay()}
          />
        )}
        {canViewTreasury && (
          <StatCard
            icon={<Wallet />}
            color="amber"
            label="Treasury balance"
            value={treasury.toFixed(2)}
            href={`/${slug}/treasury`}
            delay={nextDelay()}
          />
        )}
        {canViewBoosting && (
          <StatCard
            icon={<Megaphone />}
            color="sky"
            label="Ad spend this month"
            value={monthAdSpend.toFixed(2)}
            href={`/${slug}/boosting`}
            delay={nextDelay()}
          />
        )}
        {!canViewReports && (
          <StatCard
            icon={<Users />}
            color="pink"
            label="Team members"
            value={String(memberCount)}
            delay={nextDelay()}
          />
        )}
      </div>

      {canViewPartners && partnerShares.length > 0 && (
        <Card className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-300 delay-300">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">
              Partner profit share — total profit {profit.toFixed(2)}
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
