import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { partnerBalances, totalBusinessProfit, businessCapitalSummary } from "@/lib/finance";
import { serverT } from "@/lib/session";
import { PartnerManager } from "@/components/partners/partner-manager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Handshake } from "lucide-react";

export default async function PartnersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "partners", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canManage = can(access.role, "partners", "full", access.permissions);

  const [partners, balances, profit, members, capital] = await Promise.all([
    prisma.partner.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    partnerBalances(workspaceId),
    totalBusinessProfit(workspaceId),
    prisma.membership.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    businessCapitalSummary(workspaceId),
  ]);

  // Full transparency model (owner's decision): every partner sees every
  // partner's record. Managing (add/edit/delete) is still gated by canManage.
  const rows = partners.map((p) => {
    const b = balances.get(p.id);
    const share = Number(p.profitSharePercent);
    return {
      id: p.id,
      name: p.user.name ?? p.user.email,
      profitSharePercent: share,
      invested: b?.invested ?? 0,
      withdrawn: b?.withdrawn ?? 0,
      customerProductSpend: b?.customerProductSpend ?? 0,
      internalPurchaseSpend: b?.internalPurchaseSpend ?? 0,
      miscExpense: b?.miscExpense ?? 0,
      expenses: b?.expenses ?? 0,
      depositedToTreasury: b?.depositedToTreasury ?? 0,
      netCapital: b?.netCapital ?? 0,
      remaining: b?.remaining ?? 0,
      profitShareAmount: Math.round((share / 100) * profit * 100) / 100,
    };
  });

  // Members who aren't partners yet (for the add form).
  const partnerUserIds = new Set(partners.map((p) => p.userId));
  const memberOptions = members
    .filter((m) => !partnerUserIds.has(m.userId))
    .map((m) => ({ userId: m.userId, label: m.user.name ?? m.user.email }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Handshake />}
        color="cyan"
        title={(await serverT())("partners")}
        action={
          <span className="text-sm text-muted-foreground">
            Total business profit: <span className="font-semibold">{profit.toFixed(2)}</span>
          </span>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total invested
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {capital.totalInvested.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Customer products
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.customerProductSpend.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Internal purchases
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.internalPurchaseSpend.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Other (rent, food, etc.)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.miscExpense.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Remaining (unspent)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {capital.totalRemaining.toFixed(2)}
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Total spent (all categories): {capital.totalExpenses.toFixed(2)}. "Customer products"
        and "Internal purchases" count every recorded purchase regardless of whether it was
        tagged to a specific partner; per-partner breakdown below only reflects purchases
        tagged with "Paid by".
      </p>

      <PartnerManager
        slug={slug}
        partners={rows}
        memberOptions={memberOptions}
        canManage={canManage}
      />
    </div>
  );
}
