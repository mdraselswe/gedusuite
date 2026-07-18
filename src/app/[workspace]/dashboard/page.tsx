import { requireMembership } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { refreshInventoryAlerts } from "@/lib/inventory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { membership } = await requireMembership(slug);

  const [memberCount, alerts] = await Promise.all([
    prisma.membership.count({ where: { workspaceId: membership.workspaceId } }),
    refreshInventoryAlerts(membership.workspaceId),
  ]);

  const lowStock = alerts.filter((a) => a.type === "LOW_STOCK");
  const expiring = alerts.filter((a) => a.type === "EXPIRY");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {alerts.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <div className="font-semibold text-amber-800 dark:text-amber-300">
            {lowStock.length} low-stock · {expiring.length} expiring soon
          </div>
          <ul className="list-inside list-disc text-amber-900/90 dark:text-amber-200/90">
            {alerts.slice(0, 8).map((a) => (
              <li key={a.dedupeKey}>{a.message}</li>
            ))}
            {alerts.length > 8 && <li>…and {alerts.length - 8} more</li>}
          </ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Your role
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{membership.role}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Team members
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{memberCount}</CardContent>
        </Card>
      </div>
      <p className="text-sm text-muted-foreground">
        Modules (products, sales, partners, treasury, reports) land in later phases.
      </p>
    </div>
  );
}
