import Link from "next/link";
import { requireMembership, serverT } from "@/lib/session";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeInventoryAlerts, inventoryValue } from "@/lib/inventory";
import {
  operatingExpenses,
  overdueOrders,
  paidNotDeposited,
  totalDue,
  totalBusinessProfit,
  treasuryBalance,
} from "@/lib/finance";
import { businessMoneyPosition } from "@/lib/business-position";
import { splitByShare } from "@/lib/profit-share";
import { dhakaDayEnd, dhakaDayStart, dhakaMonthStart, dhakaToday } from "@/lib/dhaka-time";
import { computeOrderTotals, orderNetProfit } from "@/lib/orders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerShareTable } from "@/components/dashboard/partner-share-table";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { Money } from "@/components/ui/money";
import { formatMoney, round2, toneForBalance } from "@/lib/money";
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
  Banknote,
  Boxes,
  HandCoins,
  Landmark,
  Smartphone,
  Truck,
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
  // End of today in Dhaka, not this instant: a cost dated "today" carries no
  // time of day, and a range ending at 14:07 would leave it out of the month
  // it plainly belongs to.
  const monthToDateEnd = dhakaDayEnd(dhakaToday());
  const [
    memberCount,
    alerts,
    overdue,
    profit,
    treasury,
    monthExpenses,
    monthOrders,
    partners,
    stockPosition,
    unbankedMoney,
    customerDue,
  ] =
    await Promise.all([
      prisma.membership.count({ where: { workspaceId } }),
      computeInventoryAlerts(workspaceId),
      overdueOrders(workspaceId),
      totalBusinessProfit(workspaceId),
      treasuryBalance(workspaceId),
      // The whole cost of running the shop this month, not just the ads. The
      // ad-spend tile reads its figure out of the same object, so the two
      // tiles cannot describe different months.
      operatingExpenses(workspaceId, { from: monthStart, to: monthToDateEnd }),
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
      canViewReports ? inventoryValue(workspaceId) : Promise.resolve(null),
      canViewTreasury ? paidNotDeposited(workspaceId) : Promise.resolve([]),
      canViewTreasury ? totalDue(workspaceId) : Promise.resolve(null),
    ]);
  const monthAdSpend = monthExpenses.adSpend;

  let monthRevenue = 0;
  let monthTradingProfit = 0;
  for (const o of monthOrders) {
    if (o.status === "CANCELLED") {
      monthTradingProfit += orderNetProfit(o);
      continue;
    }
    const totals = computeOrderTotals(o);
    monthRevenue += totals.netRevenue;
    monthTradingProfit += totals.netProfit;
  }
  monthRevenue = round2(monthRevenue);
  monthTradingProfit = round2(monthTradingProfit);
  // What the month actually made. The tile used to show the line above it —
  // trading profit, before a taka of the advertising, the rent or the polybags
  // had been paid for — sitting next to an ad-spend tile it had not subtracted.
  // Read together they promised a month that earned ৳11,018 and separately
  // spent ৳8,165, when the month those two figures came from was ৳1,061 down.
  // This is the same subtraction the reports page calls netProfit, and it is
  // the figure partner shares are actually paid on.
  const monthProfit = round2(monthTradingProfit - monthExpenses.total);

  const lowStock = alerts.filter((a) => a.type === "LOW_STOCK");
  const expiring = alerts.filter((a) => a.type === "EXPIRY");
  const totalOverdue = overdue.reduce((s, o) => s + o.amount, 0);
  const moneyPosition = customerDue
    ? businessMoneyPosition({
        treasury,
        unbanked: unbankedMoney,
        dueGross: customerDue.gross,
        dueNet: customerDue.net,
      })
    : null;

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
            // The two layers, so nobody has to guess which one the tile is
            // showing — and so a month that traded well but spent more than it
            // made says both things at once.
            sub={`${formatMoney(monthTradingProfit)} trading − ${formatMoney(monthExpenses.total)} running costs`}
            tone={toneForBalance(monthProfit)}
            href={`/${slug}/reports`}
          />
        )}
        {canViewReports && (
          <StatTile
            icon={<Receipt />}
            color="emerald"
            label="Lifetime sales"
            value={profit.revenue}
            sub={`${profit.orderCount} total order${profit.orderCount === 1 ? "" : "s"}`}
            href={`/${slug}/reports`}
          />
        )}
        {canViewReports && (
          <StatTile
            icon={<TrendingUp />}
            color="teal"
            label="Lifetime net profit"
            value={profit.netProfit}
            sub={`${formatMoney(profit.tradingProfit)} trading − ${formatMoney(profit.operatingExpenses)} running costs`}
            tone={toneForBalance(profit.netProfit)}
            href={`/${slug}/reports`}
          />
        )}
        {canViewReports && (
          <StatTile
            icon={<Megaphone />}
            color="sky"
            label="Lifetime ad spend"
            value={profit.adSpend}
            sub="All recorded boost and advertising spend"
            href={`/${slug}/boosting`}
          />
        )}
        {canViewReports && (
          <StatTile
            icon={<Receipt />}
            color="violet"
            label="Lifetime internal purchases"
            value={profit.internalPurchaseSpend}
            sub="Internal operating purchases charged so far"
            href={`/${slug}/internal-purchases`}
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

      {(stockPosition || moneyPosition) && (
        <Card className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-300">
          <CardHeader className="space-y-1">
            <CardTitle className="text-base">Current business position</CardTitle>
            <p className="text-sm text-muted-foreground">
              What the business owns right now, without mixing stock value into cash.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {stockPosition && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Boxes className="size-4 text-emerald-600" /> Products currently in stock
                </div>
                <StatGrid>
                  <StatTile
                    label="Units on hand"
                    value={<span>{stockPosition.units.toLocaleString("en-BD")}</span>}
                    sub="Across all product variants"
                    href={`/${slug}/products`}
                  />
                  <StatTile
                    label="Stock at unit cost"
                    value={stockPosition.value}
                    sub={
                      stockPosition.inTransitUnits > 0
                        ? `On shelf; ${stockPosition.inTransitUnits.toLocaleString("en-BD")} returning unit(s) worth ${formatMoney(stockPosition.inTransitValue)} kept separate`
                        : "Units × latest purchase/catalogue cost"
                    }
                    href={`/${slug}/products`}
                  />
                  <StatTile
                    label="Stock at sale price"
                    value={stockPosition.saleValue}
                    sub={
                      stockPosition.unpricedUnits > 0
                        ? `${stockPosition.unpricedUnits.toLocaleString("en-BD")} unit(s) without a sale price excluded`
                        : "Potential sales before discounts and returns"
                    }
                    href={`/${slug}/products`}
                  />
                  <StatTile
                    label="Potential gross margin"
                    value={
                      stockPosition.unpricedUnits > 0
                        ? <span className="text-muted-foreground">Incomplete</span>
                        : round2(stockPosition.saleValue - stockPosition.value)
                    }
                    sub={
                      stockPosition.unpricedUnits > 0
                        ? "Add the missing sale prices to calculate this honestly"
                        : "Sale value − stock cost; not realised profit"
                    }
                    tone={
                      stockPosition.unpricedUnits > 0
                        ? "neutral"
                        : toneForBalance(stockPosition.saleValue - stockPosition.value)
                    }
                  />
                </StatGrid>
              </div>
            )}

            {moneyPosition && (
              <div className="space-y-2 border-t pt-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <HandCoins className="size-4 text-amber-600" /> Money and receivables
                </div>
                <StatGrid>
                  <StatTile icon={<Landmark />} color="amber" label="In treasury" value={moneyPosition.treasury} href={`/${slug}/treasury`} />
                  <StatTile icon={<Truck />} color="violet" label="With courier" value={moneyPosition.courier} tone={toneForBalance(moneyPosition.courier)} href={`/${slug}/couriers`} />
                  <StatTile icon={<Banknote />} color="emerald" label="Cash not deposited" value={moneyPosition.cash} href={`/${slug}/treasury`} />
                  <StatTile icon={<Smartphone />} color="pink" label="bKash not deposited" value={moneyPosition.bkash} href={`/${slug}/treasury`} />
                  <StatTile label="Nagad not deposited" value={moneyPosition.nagad} href={`/${slug}/treasury`} />
                  <StatTile label="Other not deposited" value={moneyPosition.other} href={`/${slug}/treasury`} />
                  <StatTile
                    label="Customer due"
                    value={moneyPosition.dueNet}
                    sub={
                      moneyPosition.dueGross !== moneyPosition.dueNet
                        ? `${formatMoney(moneyPosition.dueGross)} customers owe; ${formatMoney(moneyPosition.dueGross - moneyPosition.dueNet)} courier charges will be deducted`
                        : "Still to be collected from customers"
                    }
                    href={`/${slug}/treasury`}
                  />
                  <StatTile
                    label="Total excluding products"
                    value={moneyPosition.totalExcludingStock}
                    sub="Treasury + courier + cash + mobile money + net customer due"
                    tone={toneForBalance(moneyPosition.totalExcludingStock)}
                  />
                </StatGrid>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
