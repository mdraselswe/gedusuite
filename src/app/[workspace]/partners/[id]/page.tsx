import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { partnerBalances } from "@/lib/finance";
import { derivedSource } from "@/lib/partner-credit";
import { PartnerTxnManager } from "@/components/partners/partner-txn-manager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { RecordHistory } from "@/components/activity/record-history";

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "partners", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const partner = await prisma.partner.findFirst({
    where: { id, workspaceId: access.workspaceId },
    include: {
      user: { select: { name: true, email: true } },
      txns: { orderBy: { date: "desc" } },
    },
  });
  if (!partner) notFound();

  // Full transparency model: any member with partners-view access can open
  // any partner's ledger (matches the list page). Writes stay role-gated.

  const balances = (await partnerBalances(access.workspaceId)).get(partner.id);
  const canAdd =
    can(access.role, "partners", "add", access.permissions) &&
    (access.role !== "PARTNER" || partner.userId === access.userId);
  const canDelete = can(access.role, "partners", "edit", access.permissions);

  const txns = partner.txns.map((t) => {
    const from = derivedSource(t);
    return {
      id: t.id,
      date: t.date.toISOString().slice(0, 10),
      type: t.type,
      amount: Number(t.amount),
      purpose: t.purpose,
      derivedFrom: from?.tag ?? null,
      derivedKind: from?.kind ?? null,
    };
  });

  const cards: [string, number][] = [
    ["Invested", balances?.invested ?? 0],
    ["Customer products", balances?.customerProductSpend ?? 0],
    ["Internal purchases", balances?.internalPurchaseSpend ?? 0],
    ["Boosting (ads)", balances?.boostSpend ?? 0],
    ["Other (rent, food, etc.)", balances?.miscExpense ?? 0],
    ["Total spent", balances?.expenses ?? 0],
    ["Remaining (unspent)", balances?.remaining ?? 0],
    ["Withdrawn", balances?.withdrawn ?? 0],
    ["To treasury", balances?.depositedToTreasury ?? 0],
    ["Net capital", balances?.netCapital ?? 0],
  ];

  return (
    <div className="space-y-6">
      <Link href={`/${slug}/partners`} className="text-sm text-muted-foreground underline">
        ← Partners
      </Link>
      <div>
        <h1 className="text-2xl font-bold">{partner.user.name ?? partner.user.email}</h1>
        <p className="text-sm text-muted-foreground">
          Profit share {Number(partner.profitSharePercent).toFixed(2)}%
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([label, val]) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-lg font-bold"><Money value={val} /></CardContent>
          </Card>
        ))}
      </div>

      <PartnerTxnManager
        slug={slug}
        partnerId={partner.id}
        txns={txns}
        canAdd={canAdd}
        canDelete={canDelete}
      />
      <RecordHistory
        workspaceId={access.workspaceId}
        entity="Partner"
        entityId={partner.id}
      />
    </div>
  );
}
