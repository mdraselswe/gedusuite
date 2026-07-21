import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PurchaseManager } from "@/components/purchases/purchase-manager";
import { treasuryBalance } from "@/lib/finance";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { ShoppingCart } from "lucide-react";

const PAGE_SIZE = 50;

export default async function PurchasesPage({
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
  if (!can(access.role, "purchases", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "purchases", "add", access.permissions),
    canEdit: can(access.role, "purchases", "edit", access.permissions),
  };

  // Products are searched on demand by the form's async picker, so we only
  // need a cheap existence check here, not the full catalog.
  const [productCount, suppliers, purchaseCount, purchases, partners, treasury, allCostQuantities] =
    await Promise.all([
      prisma.productVariant.count({ where: { product: { workspaceId: access.workspaceId } } }),
      prisma.supplier.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      prisma.purchase.count({ where: { workspaceId: access.workspaceId } }),
      prisma.purchase.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { date: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          supplier: { select: { name: true } },
          paidByPartner: { select: { user: { select: { name: true, email: true } } } },
          productVariant: {
            select: {
              size: true,
              color: true,
              product: { select: { name: true, expiryTracked: true } },
            },
          },
        },
      }),
      prisma.partner.findMany({
        where: { workspaceId: access.workspaceId },
        select: { id: true, user: { select: { name: true, email: true } } },
      }),
      treasuryBalance(access.workspaceId),
      // Lightweight full-table fetch (no relations) just for the total-spend
      // figure — must reflect every row, not just the current page.
      prisma.purchase.findMany({
        where: { workspaceId: access.workspaceId },
        select: { unitCost: true, quantity: true },
      }),
    ]);

  const totalSpend = allCostQuantities.reduce((s, r) => s + Number(r.unitCost) * r.quantity, 0);

  const purchaseRows = purchases.map((pu) => ({
    id: pu.id,
    date: pu.date.toISOString().slice(0, 10),
    productVariantId: pu.productVariantId,
    product:
      pu.productVariant.product.name +
      ([pu.productVariant.size, pu.productVariant.color].filter(Boolean).length
        ? ` (${[pu.productVariant.size, pu.productVariant.color].filter(Boolean).join(" / ")})`
        : ""),
    expiryTracked: pu.productVariant.product.expiryTracked,
    supplierId: pu.supplierId,
    supplier: pu.supplier?.name ?? "—",
    paidByPartnerId: pu.paidByPartnerId,
    paidBy: pu.paidByPartner
      ? (pu.paidByPartner.user.name ?? pu.paidByPartner.user.email)
      : null,
    paidFromTreasury: pu.paidFromTreasury,
    unitCost: Number(pu.unitCost),
    quantity: pu.quantity,
    expiryDate: pu.expiryDate ? pu.expiryDate.toISOString().slice(0, 10) : null,
  }));

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<ShoppingCart />}
        color="orange"
        title={(await serverT())("purchases")}
        action={
          <span className="text-sm text-muted-foreground">
            Total spend: <span className="font-semibold">{totalSpend.toFixed(2)}</span>
          </span>
        }
      />
      <PurchaseManager
        slug={slug}
        hasProducts={productCount > 0}
        suppliers={suppliers}
        partnerOptions={partnerOptions}
        purchases={purchaseRows}
        treasuryBalance={treasury}
        perms={perms}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(purchaseCount / PAGE_SIZE)}
        basePath={`/${slug}/purchases`}
      />
    </div>
  );
}
