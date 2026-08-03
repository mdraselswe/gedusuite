import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { variantFullName } from "@/lib/variants";
import { ReconcileManager, type ReconcileGroup } from "@/components/partners/reconcile-manager";
import { PageHeader } from "@/components/ui/page-header";
import { Scale } from "lucide-react";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One-time cleanup for purchases made before the partner credit was derived
 * from the purchase itself. Each unlinked row either already has a credit
 * someone typed in — which should be adopted — or never got one, which should
 * be generated. Nothing in the data tells the two apart, so a human decides.
 *
 * Once the list is empty this page has no further purpose; the link into it
 * disappears from the partners page at the same time.
 */
export default async function ReconcilePartnerCreditsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  // Rewriting the ledger is owner-level, the same bar as deleting an entry.
  if (!can(access.role, "partners", "edit", access.permissions)) {
    redirect(`/${slug}/partners`);
  }
  const workspaceId = access.workspaceId;

  const unfunded = { workspaceId, paidByPartnerId: { not: null }, partnerTxn: { is: null } };
  const [partners, purchases, internals, manualTxns] = await Promise.all([
    prisma.partner.findMany({
      where: { workspaceId },
      select: { id: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.purchase.findMany({
      where: unfunded,
      select: {
        id: true,
        date: true,
        unitCost: true,
        quantity: true,
        paidByPartnerId: true,
        productVariant: { select: { attributes: true, product: { select: { name: true } } } },
      },
      orderBy: { date: "desc" },
    }),
    prisma.internalPurchase.findMany({
      where: unfunded,
      select: {
        id: true,
        date: true,
        cost: true,
        quantity: true,
        itemName: true,
        paidByPartnerId: true,
      },
      orderBy: { date: "desc" },
    }),
    // Hand-typed investments — anything already tied to a source is off limits.
    prisma.partnerTxn.findMany({
      where: {
        workspaceId,
        type: "INVESTMENT",
        distributionId: null,
        boostSpendId: null,
        purchaseId: null,
        internalPurchaseId: null,
      },
      select: { id: true, partnerId: true, date: true, amount: true, purpose: true },
      orderBy: { date: "desc" },
    }),
  ]);

  const groups: ReconcileGroup[] = partners
    .map((p) => ({
      partnerId: p.id,
      partnerName: p.user.name ?? p.user.email,
      sources: [
        ...purchases
          .filter((r) => r.paidByPartnerId === p.id)
          .map((r) => ({
            kind: "PURCHASE" as const,
            id: r.id,
            date: day(r.date),
            label: variantFullName(r.productVariant.product.name, r.productVariant.attributes),
            amount: round2(Number(r.unitCost) * r.quantity),
          })),
        ...internals
          .filter((r) => r.paidByPartnerId === p.id)
          .map((r) => ({
            kind: "INTERNAL" as const,
            id: r.id,
            date: day(r.date),
            label: r.itemName,
            amount: round2(Number(r.cost) * r.quantity),
          })),
      ].sort((a, b) => b.date.localeCompare(a.date)),
      manual: manualTxns
        .filter((t) => t.partnerId === p.id)
        .map((t) => ({
          id: t.id,
          date: day(t.date),
          purpose: t.purpose,
          amount: round2(Number(t.amount)),
        })),
    }))
    .filter((g) => g.sources.length > 0);

  const total = groups.reduce((s, g) => s + g.sources.length, 0);

  return (
    <div className="space-y-6">
      <Link href={`/${slug}/partners`} className="text-sm text-muted-foreground underline">
        ← Partners
      </Link>
      <PageHeader
        icon={<Scale />}
        color="cyan"
        count={total}
        title="Reconcile partner credits"
      />
      <ReconcileManager slug={slug} groups={groups} />
    </div>
  );
}
