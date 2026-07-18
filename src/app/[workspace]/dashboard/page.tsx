import { requireMembership, serverT } from "@/lib/session";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { refreshInventoryAlerts } from "@/lib/inventory";
import {
  refreshOverdueAlerts,
  totalBusinessProfit,
  treasuryBalance,
} from "@/lib/finance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

  const [memberCount, alerts, overdue, profit, treasury] = await Promise.all([
    prisma.membership.count({ where: { workspaceId } }),
    refreshInventoryAlerts(workspaceId),
    refreshOverdueAlerts(workspaceId),
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
      <h1 className="text-2xl font-bold">{t("dashboard")}</h1>

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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Your role</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{membership.role}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Team members</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{memberCount}</CardContent>
        </Card>
        {canViewTreasury && (
          <Card>
            <CardHeader className="pb-2">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead className="text-right">Share %</TableHead>
                  <TableHead className="text-right">Share amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partnerShares.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-right">{p.percent.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-medium">{p.amount.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
