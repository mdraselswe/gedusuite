import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { InternalPurchaseManager } from "@/components/internal-purchases/internal-purchase-manager";
import { serverT } from "@/lib/session";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { ClipboardList } from "lucide-react";

const PAGE_SIZE = 50;

export default async function InternalPurchasesPage({
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
  if (!can(access.role, "internal-purchases", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "internal-purchases", "add", access.permissions),
    canEdit: can(access.role, "internal-purchases", "edit", access.permissions),
  };

  const [itemCount, items, partners, allCostQuantities] = await Promise.all([
    prisma.internalPurchase.count({ where: { workspaceId: access.workspaceId } }),
    prisma.internalPurchase.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { date: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        paidByPartner: { select: { id: true, user: { select: { name: true, email: true } } } },
      },
    }),
    prisma.partner.findMany({
      where: { workspaceId: access.workspaceId },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
    // Lightweight full-table fetch (no relations) just for the total-spend
    // figure — must reflect every row, not just the current page.
    prisma.internalPurchase.findMany({
      where: { workspaceId: access.workspaceId },
      select: { cost: true, quantity: true },
    }),
  ]);

  const rows = items.map((i) => ({
    id: i.id,
    date: i.date.toISOString().slice(0, 10),
    itemName: i.itemName,
    description: i.description,
    supplierName: i.supplierName,
    paidBy: i.paidByPartner ? (i.paidByPartner.user.name ?? i.paidByPartner.user.email) : null,
    paidByPartnerId: i.paidByPartnerId,
    cost: Number(i.cost),
    quantity: i.quantity,
    category: i.category,
  }));

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  const totalSpend = allCostQuantities.reduce((s, r) => s + Number(r.cost) * r.quantity, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        icon={<ClipboardList />}
        color="indigo"
        title={(await serverT())("internalPurchases")}
        action={
          <span className="text-sm text-muted-foreground">
            Total spend: <span className="font-semibold">{totalSpend.toFixed(2)}</span>
          </span>
        }
      />
      <InternalPurchaseManager
        slug={slug}
        items={rows}
        partnerOptions={partnerOptions}
        perms={perms}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(itemCount / PAGE_SIZE)}
        basePath={`/${slug}/internal-purchases`}
      />
    </div>
  );
}
