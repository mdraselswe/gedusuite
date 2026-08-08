import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { serverT } from "@/lib/session";
import { BoostingManager } from "@/components/boosting/boosting-manager";
import { PageHeader } from "@/components/ui/page-header";
import { Megaphone } from "lucide-react";
import {
  buildCampaignResult,
  campaignWindow,
  roasVerdict,
  toAttributable,
} from "@/lib/boost-results";
import { Money } from "@/components/ui/money";

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

  // Orders are read once from the earliest campaign start onwards and then
  // attributed to each campaign in memory — one query for the page rather than
  // one per campaign, and nothing older than the oldest campaign is touched.
  const windows = new Map(campaigns.map((c) => [c.id, campaignWindow(c.adSets)]));
  const earliestStart = [...windows.values()].reduce<Date | null>(
    (min, w) => (w && (min === null || w.from < min) ? w.from : min),
    null,
  );
  const orderRows = earliestStart
    ? await prisma.order.findMany({
        where: {
          workspaceId,
          OR: [{ date: { gte: earliestStart } }, { boostCampaignId: { not: null } }],
        },
        select: {
          id: true,
          date: true,
          status: true,
          source: true,
          boostCampaignId: true,
          customer: { select: { name: true } },
          discount: true,
          deliveryCharge: true,
          deliveryCost: true,
          packagingCost: true,
          giftCost: true,
          codFeeCost: true,
          cancelledCollected: true,
          items: {
            select: {
              unitPrice: true,
              unitCost: true,
              quantity: true,
              discount: true,
              returns: { select: { quantity: true, refundAmount: true } },
            },
          },
        },
      })
    : [];
  const attributable = orderRows.map(toAttributable);

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
    const result = buildCampaignResult(
      { id: c.id, name: c.name, channel: c.channel, window: windows.get(c.id) ?? null },
      attributable,
      totalSpent,
      now,
    );
    return {
      id: c.id,
      name: c.name,
      objective: c.objective,
      channel: c.channel,
      status: c.status,
      adSetCount: c.adSets.length,
      activeAdSets: c.adSets.filter((a) => a.status === "ACTIVE").length,
      totalSpent,
      firstStart: starts[0] ? starts[0].toISOString().slice(0, 10) : null,
      lastEnd: openEnded ? null : lastEnd ? lastEnd.toISOString().slice(0, 10) : null,
      openEnded,
      basis: result.basis,
      orders: result.orders,
      revenue: result.revenue,
      profitAfterAds: result.profitAfterAds,
      roas: result.roas,
      margin: result.margin,
      breakEvenRoas: result.breakEvenRoas,
      // Judged here rather than in the table: whether a ROAS is good depends
      // on this campaign's own margin, which the row alone doesn't carry.
      roasTone: roasVerdict(result),
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
                <Money value={round2(monthSpend)} />
              </span>
            </span>
            <span>
              All time:{" "}
              <span className="text-lg font-bold text-foreground">
                <Money value={round2(totalSpendAll)} />
              </span>
            </span>
          </div>
        }
      />
      <BoostingManager slug={slug} campaigns={rows} canAdd={canAdd} canDelete={canDelete} />
    </div>
  );
}
