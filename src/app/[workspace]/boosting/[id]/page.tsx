import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { CampaignDetail } from "@/components/boosting/campaign-detail";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ArrowLeft, Megaphone } from "lucide-react";

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

  const [campaign, partners] = await Promise.all([
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
          status: campaign.status,
          notes: campaign.notes,
          totalSpent,
        }}
        adSets={adSets}
        partnerOptions={partnerOptions}
        canAdd={canAdd}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
