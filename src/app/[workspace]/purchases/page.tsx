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

// URL ?sort= values → Prisma orderBy. Falls back to newest-first.
const SORTS = {
  date_desc: { date: "desc" },
  date_asc: { date: "asc" },
  cost_desc: { unitCost: "desc" },
  cost_asc: { unitCost: "asc" },
  qty_desc: { quantity: "desc" },
  qty_asc: { quantity: "asc" },
} as const;
export type PurchaseSort = keyof typeof SORTS;

export default async function PurchasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; q?: string; sort?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? "").trim();
  const sort: PurchaseSort = sp.sort && sp.sort in SORTS ? (sp.sort as PurchaseSort) : "date_desc";
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "purchases", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "purchases", "add", access.permissions),
    canEdit: can(access.role, "purchases", "edit", access.permissions),
  };

  // Search filters the WHOLE table (all pages), not just the current page —
  // the query narrows the paginated result set server-side.
  const where = {
    workspaceId: access.workspaceId,
    ...(q
      ? {
          OR: [
            { productVariant: { product: { name: { contains: q, mode: "insensitive" as const } } } },
            { productVariant: { product: { sku: { contains: q, mode: "insensitive" as const } } } },
            { productVariant: { sku: { contains: q, mode: "insensitive" as const } } },
            { supplier: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
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
      prisma.purchase.count({ where }),
      prisma.purchase.findMany({
        where,
        orderBy: SORTS[sort],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          supplier: { select: { name: true } },
          paidByPartner: { select: { user: { select: { name: true, email: true } } } },
          productVariant: {
            select: {
              size: true,
              color: true,
              product: { select: { name: true, expiryTracked: true, unitsPerPack: true } },
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
    unitsPerPack: pu.productVariant.product.unitsPerPack,
    supplierId: pu.supplierId,
    supplier: pu.supplier?.name ?? "—",
    paidByPartnerId: pu.paidByPartnerId,
    paidBy: pu.paidByPartner
      ? (pu.paidByPartner.user.name ?? pu.paidByPartner.user.email)
      : null,
    paidFromTreasury: pu.paidFromTreasury,
    unitCost: Number(pu.unitCost),
    salePrice: pu.salePrice != null ? Number(pu.salePrice) : null,
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
        query={q}
        sort={sort}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(purchaseCount / PAGE_SIZE)}
        basePath={`/${slug}/purchases`}
        query={{ q: q || undefined, sort: sort !== "date_desc" ? sort : undefined }}
      />
    </div>
  );
}
