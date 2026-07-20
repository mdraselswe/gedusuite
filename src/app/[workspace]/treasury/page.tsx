import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  treasuryBalance,
  refreshOverdueAlerts,
  cashHeldByMember,
  totalDue,
  paidNotDeposited,
} from "@/lib/finance";
import { serverT } from "@/lib/session";
import { TreasuryManager } from "@/components/treasury/treasury-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";

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

  const [balance, entryCount, entries, partners, overdue, heldCash, due, notDeposited] = await Promise.all([
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
    refreshOverdueAlerts(workspaceId),
    cashHeldByMember(workspaceId),
    totalDue(workspaceId),
    paidNotDeposited(workspaceId),
  ]);

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
  }));

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">{(await serverT())("treasury")}</h1>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <span>
            Balance: <span className="text-lg font-bold text-foreground">{balance.toFixed(2)}</span>
          </span>
          <span>
            Due: <span className="text-lg font-bold text-destructive">{due.toFixed(2)}</span>
          </span>
        </div>
      </div>
      <TreasuryManager
        slug={slug}
        balance={balance}
        entries={entryRows}
        partnerOptions={partnerOptions}
        overdue={overdue}
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
