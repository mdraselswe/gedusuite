import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { serverT } from "@/lib/session";
import { BoostingManager } from "@/components/boosting/boosting-manager";
import { PageHeader } from "@/components/ui/page-header";
import { Megaphone } from "lucide-react";

export default async function BoostingPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "boosting", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canAdd = can(access.role, "boosting", "add", access.permissions);
  const canDelete = can(access.role, "boosting", "full", access.permissions);

  const campaigns = await prisma.boostCampaign.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      adSets: {
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          spends: { select: { amount: true, date: true } },
        },
      },
    },
  });

  const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  let totalSpendAll = 0;
  let monthSpend = 0;

  const rows = campaigns.map((c) => {
    const spends = c.adSets.flatMap((a) => a.spends);
    const totalSpent = round2(spends.reduce((s, x) => s + Number(x.amount), 0));
    totalSpendAll += totalSpent;
    monthSpend += spends
      .filter((x) => x.date >= monthStart)
      .reduce((s, x) => s + Number(x.amount), 0);
    const starts = c.adSets.map((a) => a.startDate).sort((a, b) => +a - +b);
    const ends = c.adSets.map((a) => a.endDate);
    const openEnded = ends.some((e) => e === null);
    const lastEnd = ends
      .filter((e): e is Date => e !== null)
      .sort((a, b) => +b - +a)[0];
    return {
      id: c.id,
      name: c.name,
      objective: c.objective,
      status: c.status,
      adSetCount: c.adSets.length,
      activeAdSets: c.adSets.filter((a) => a.status === "ACTIVE").length,
      totalSpent,
      firstStart: starts[0] ? starts[0].toISOString().slice(0, 10) : null,
      lastEnd: openEnded ? null : lastEnd ? lastEnd.toISOString().slice(0, 10) : null,
      openEnded,
    };
  });

  const t = await serverT();

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Megaphone />}
        color="sky"
        title={t("boosting")}
        action={
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>
              This month:{" "}
              <span className="text-lg font-bold text-foreground">
                {round2(monthSpend).toFixed(2)}
              </span>
            </span>
            <span>
              All time:{" "}
              <span className="text-lg font-bold text-foreground">
                {round2(totalSpendAll).toFixed(2)}
              </span>
            </span>
          </div>
        }
      />
      <BoostingManager slug={slug} campaigns={rows} canAdd={canAdd} canDelete={canDelete} />
    </div>
  );
}
