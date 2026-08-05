import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { CampaignDetail } from "@/components/boosting/campaign-detail";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ArrowLeft, Megaphone } from "lucide-react";
import { computeOrderTotals } from "@/lib/orders";
import {
  buildCampaignResult,
  campaignWindow,
  overlappingCampaigns,
} from "@/lib/boost-results";

/** Ad set dates are date-only, so a window's last day counts in full. */
function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

export default async function BoostCampaignPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "boosting", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const canAdd = can(access.role, "boosting", "add", access.permissions);
  const canEdit = can(access.role, "boosting", "edit", access.permissions);
  const canDelete = can(access.role, "boosting", "full", access.permissions);

  const [campaign, partners, otherCampaigns] = await Promise.all([
    prisma.boostCampaign.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        adSets: {
          orderBy: { createdAt: "desc" },
          include: {
            spends: {
              orderBy: { date: "desc" },
              include: {
                paidByPartner: {
                  select: { user: { select: { name: true, email: true } } },
                },
              },
            },
          },
        },
      },
    }),
    prisma.partner.findMany({
      where: { workspaceId: access.workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    // Needed only to warn about campaigns whose estimate claims the same
    // orders as this one's, so nothing beyond their windows is loaded.
    prisma.boostCampaign.findMany({
      where: { workspaceId: access.workspaceId, id: { not: id } },
      select: {
        id: true,
        name: true,
        channel: true,
        adSets: { select: { startDate: true, endDate: true } },
      },
    }),
  ]);
  if (!campaign) notFound();

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

  const adSets = campaign.adSets.map((a) => {
    const totalSpent = round2(a.spends.reduce((s, x) => s + Number(x.amount), 0));
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      startDate: a.startDate.toISOString().slice(0, 10),
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      dailyBudget: a.dailyBudget !== null ? Number(a.dailyBudget) : null,
      notes: a.notes,
      totalSpent,
      spends: a.spends.map((x) => ({
        id: x.id,
        date: x.date.toISOString().slice(0, 10),
        amount: Number(x.amount),
        note: x.note,
        paidFrom: x.paidFromTreasury
          ? "Treasury"
          : x.paidByPartner
            ? (x.paidByPartner.user.name ?? x.paidByPartner.user.email)
            : null,
      })),
    };
  });

  const totalSpent = round2(adSets.reduce((s, a) => s + a.totalSpent, 0));

  // ── What the campaign brought in ──
  // Orders are pulled from the campaign's own window (plus anything tagged to
  // it, whenever it was placed) rather than the whole table: a shop with years
  // of orders shouldn't load all of them to price one campaign.
  const window = campaignWindow(campaign.adSets);
  const orderRows = await prisma.order.findMany({
    where: {
      workspaceId: access.workspaceId,
      status: { not: "CANCELLED" },
      OR: [
        { boostCampaignId: id },
        ...(window
          ? [{ date: { gte: window.from, ...(window.to ? { lte: endOfDay(window.to) } : {}) } }]
          : []),
      ],
    },
    select: {
      date: true,
      source: true,
      boostCampaignId: true,
      discount: true,
      deliveryCharge: true,
      deliveryCost: true,
      packagingCost: true,
      giftCost: true,
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
  });

  const result = buildCampaignResult(
    { id, name: campaign.name, channel: campaign.channel, window },
    orderRows.map((o) => {
      const t = computeOrderTotals(o);
      return {
        date: o.date,
        source: o.source,
        boostCampaignId: o.boostCampaignId,
        netRevenue: t.netRevenue,
        netProfit: t.netProfit,
      };
    }),
    totalSpent,
  );

  const overlaps = overlappingCampaigns(
    { id, name: campaign.name, channel: campaign.channel, window },
    otherCampaigns.map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      window: campaignWindow(c.adSets),
    })),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Megaphone />}
        color="sky"
        title={campaign.name}
        action={
          <Link
            href={`/${slug}/boosting`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft className="size-4" /> All campaigns
          </Link>
        }
      />
      <CampaignDetail
        slug={slug}
        campaign={{
          id: campaign.id,
          name: campaign.name,
          objective: campaign.objective,
          channel: campaign.channel,
          status: campaign.status,
          notes: campaign.notes,
          totalSpent,
        }}
        result={result}
        overlaps={overlaps}
        window={
          window
            ? {
                from: window.from.toISOString().slice(0, 10),
                to: window.to ? window.to.toISOString().slice(0, 10) : null,
              }
            : null
        }
        adSets={adSets}
        partnerOptions={partnerOptions}
        canAdd={canAdd}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
