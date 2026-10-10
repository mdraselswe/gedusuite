import { redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/page-header";
import { BillingPanel } from "@/components/billing/billing-panel";
import { billingEnforced, entitlementOf, usageOf } from "@/lib/billing";
import { paymentInstructions } from "@/lib/billing-admin";
import { PLANS, SELLABLE, priceFor } from "@/lib/plans";

export default async function BillingPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  // Owner only: this is the account's money and its plan.
  if (!can(access.role, "team", "full", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const [ent, usage, invoices] = await Promise.all([
    entitlementOf(access.workspaceId),
    usageOf(access.workspaceId),
    prisma.billingInvoice.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader icon={<CreditCard />} color="emerald" title="Plan & billing" />
      <BillingPanel
        slug={slug}
        enforced={billingEnforced()}
        current={{
          planKey: ent.plan.key,
          planName: ent.plan.name,
          state: ent.state,
          status: ent.status,
          daysLeft: ent.daysLeft,
          until: (ent.status === "TRIALING" ? ent.trialEndsAt : ent.currentPeriodEnd)?.toISOString() ?? null,
          cycle: ent.cycle,
        }}
        limits={ent.plan.limits}
        usage={usage}
        plans={SELLABLE.map((k) => ({
          key: k,
          name: PLANS[k].name,
          tagline: PLANS[k].tagline,
          highlights: PLANS[k].highlights,
          monthly: priceFor(k, "MONTHLY"),
          yearly: priceFor(k, "YEARLY"),
        }))}
        instructions={paymentInstructions()}
        invoices={invoices.map((i) => ({
          id: i.id,
          number: i.number,
          planName: PLANS[i.planKey as keyof typeof PLANS]?.name ?? i.planKey,
          cycle: i.cycle,
          amount: Number(i.amount),
          status: i.status,
          submitted: i.submittedAt !== null,
          trxId: i.trxId,
          rejectReason: i.rejectReason,
          createdAt: i.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
