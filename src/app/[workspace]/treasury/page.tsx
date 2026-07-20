import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { treasuryBalance, refreshOverdueAlerts, cashHeldByMember } from "@/lib/finance";
import { serverT } from "@/lib/session";
import { TreasuryManager } from "@/components/treasury/treasury-manager";

export default async function TreasuryPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "treasury", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canManage = can(access.role, "treasury", "full", access.permissions);

  const [balance, entries, partners, overdue, heldCash] = await Promise.all([
    treasuryBalance(workspaceId),
    prisma.treasuryEntry.findMany({
      where: { workspaceId },
      orderBy: { date: "desc" },
      take: 200,
      include: { partner: { include: { user: { select: { name: true, email: true } } } } },
    }),
    prisma.partner.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
    }),
    refreshOverdueAlerts(workspaceId),
    cashHeldByMember(workspaceId),
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
  }));

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">{(await serverT())("treasury")}</h1>
        <span className="text-sm text-muted-foreground">
          Balance: <span className="text-lg font-bold text-foreground">{balance.toFixed(2)}</span>
        </span>
      </div>
      <TreasuryManager
        slug={slug}
        balance={balance}
        entries={entryRows}
        partnerOptions={partnerOptions}
        overdue={overdue}
        heldCash={heldCash}
        canManage={canManage}
      />
    </div>
  );
}
