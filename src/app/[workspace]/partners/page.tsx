import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { partnerBalances, totalBusinessProfit } from "@/lib/finance";
import { PartnerManager } from "@/components/partners/partner-manager";

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

  const [partners, balances, profit, members] = await Promise.all([
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
  ]);

  // A PARTNER only sees their own record; OWNER/MANAGER see everyone.
  const visible =
    access.role === "PARTNER"
      ? partners.filter((p) => p.userId === access.userId)
      : partners;

  const rows = visible.map((p) => {
    const b = balances.get(p.id);
    const share = Number(p.profitSharePercent);
    return {
      id: p.id,
      name: p.user.name ?? p.user.email,
      profitSharePercent: share,
      invested: b?.invested ?? 0,
      withdrawn: b?.withdrawn ?? 0,
      expenses: b?.expenses ?? 0,
      depositedToTreasury: b?.depositedToTreasury ?? 0,
      netCapital: b?.netCapital ?? 0,
      profitShareAmount: Math.round((share / 100) * profit * 100) / 100,
    };
  });

  // Members who aren't partners yet (for the add form).
  const partnerUserIds = new Set(partners.map((p) => p.userId));
  const memberOptions = members
    .filter((m) => !partnerUserIds.has(m.userId))
    .map((m) => ({ userId: m.userId, label: m.user.name ?? m.user.email }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Partners</h1>
        <span className="text-sm text-muted-foreground">
          Total business profit: <span className="font-semibold">{profit.toFixed(2)}</span>
        </span>
      </div>
      <PartnerManager
        slug={slug}
        partners={rows}
        memberOptions={memberOptions}
        canManage={canManage}
      />
    </div>
  );
}
