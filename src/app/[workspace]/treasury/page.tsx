import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  treasuryBalance,
  refreshOverdueAlerts,
  overdueOrders,
  cashHeldByMember,
  totalDue,
  paidNotDeposited,
} from "@/lib/finance";
import { serverT } from "@/lib/session";
import { TreasuryManager } from "@/components/treasury/treasury-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Wallet } from "lucide-react";

const PAGE_SIZE = 50;

export default async function TreasuryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { workspace: slug } = await params;
  const page = parsePage((await searchParams).page);
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "treasury", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canManage = can(access.role, "treasury", "full", access.permissions);

  const [balance, entryCount, entries, partners, allDue, heldCash, due, notDeposited, distributions] =
    await Promise.all([
      treasuryBalance(workspaceId),
      prisma.treasuryEntry.count({ where: { workspaceId } }),
      prisma.treasuryEntry.findMany({
        where: { workspaceId },
        orderBy: { date: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { partner: { include: { user: { select: { name: true, email: true } } } } },
      }),
      prisma.partner.findMany({
        where: { workspaceId },
        include: { user: { select: { name: true, email: true } } },
      }),
      // Every unpaid/partial order (days=0), not just week-old ones — the card
      // itself flags which rows have crossed the overdue threshold. The alert
      // reconciliation below still uses the 7-day cutoff for notifications.
      overdueOrders(workspaceId, 0),
      cashHeldByMember(workspaceId),
      totalDue(workspaceId),
      paidNotDeposited(workspaceId),
      prisma.profitDistribution.findMany({
        where: { workspaceId },
        orderBy: { date: "desc" },
        take: 200, // client-side pagination in the table handles the rest
      }),
    ]);

  // Keep OVERDUE_PAYMENT notifications reconciled (7-day threshold).
  await refreshOverdueAlerts(workspaceId);

  const entryRows = entries.map((e) => ({
    id: e.id,
    date: e.date.toISOString().slice(0, 10),
    type: e.type,
    amount: Number(e.amount),
    source: e.source,
    note: e.note,
    partnerName: e.partner ? (e.partner.user.name ?? e.partner.user.email) : null,
    fromDeposit: !!e.partnerTxnId,
    fromOrder: !!e.orderId,
    fromPurchase: !!e.purchaseId || !!e.internalPurchaseId,
    fromDistribution: !!e.distributionId,
  }));

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  const sharePartners = partners
    .filter((p) => Number(p.profitSharePercent) > 0)
    .map((p) => ({
      id: p.id,
      label: p.user.name ?? p.user.email,
      percent: Number(p.profitSharePercent),
    }));

  const distributionRows = distributions.map((d) => ({
    id: d.id,
    date: d.date.toISOString().slice(0, 10),
    totalAmount: Number(d.totalAmount),
    note: d.note,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Wallet />}
        color="amber"
        title={(await serverT())("treasury")}
        action={
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>
              Balance: <span className="text-lg font-bold text-foreground">{balance.toFixed(2)}</span>
            </span>
            <span>
              Due: <span className="text-lg font-bold text-destructive">{due.toFixed(2)}</span>
            </span>
          </div>
        }
      />
      <TreasuryManager
        slug={slug}
        balance={balance}
        entries={entryRows}
        partnerOptions={partnerOptions}
        sharePartners={sharePartners}
        distributions={distributionRows}
        overdue={allDue}
        heldCash={heldCash}
        notDeposited={notDeposited}
        canManage={canManage}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(entryCount / PAGE_SIZE)}
        basePath={`/${slug}/treasury`}
      />
    </div>
  );
}
