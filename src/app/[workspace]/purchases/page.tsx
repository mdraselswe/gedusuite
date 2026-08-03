import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PurchaseManager } from "@/components/purchases/purchase-manager";
import { treasuryBalance } from "@/lib/finance";
import { variantFullName } from "@/lib/variants";
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
  searchParams: Promise<{
    page?: string;
    q?: string;
    sort?: string;
    supplier?: string;
    from?: string;
    to?: string;
    min?: string;
    max?: string;
    funding?: string;
    partner?: string;
  }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? "").trim();
  const supplierFilter = (sp.supplier ?? "").trim();
  // Filters reach the database rather than the current page: narrowing a
  // paginated list client-side would silently hide matches on other pages.
  const listFilters = {
    from: (sp.from ?? "").trim(),
    to: (sp.to ?? "").trim(),
    min: (sp.min ?? "").trim(),
    max: (sp.max ?? "").trim(),
    funding: (sp.funding ?? "").trim(),
    partner: (sp.partner ?? "").trim(),
  };
  const num = (v: string) => (v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
  // A date-only string is midnight UTC; the "to" end has to cover the whole
  // of that day or a same-day range would match nothing.
  const endOfDay = (v: string) => (v ? new Date(`${v}T23:59:59.999Z`) : undefined);
  const dateWhere =
    listFilters.from || listFilters.to
      ? {
          date: {
            ...(listFilters.from ? { gte: new Date(listFilters.from) } : {}),
            ...(listFilters.to ? { lte: endOfDay(listFilters.to)! } : {}),
          },
        }
      : {};
  const costWhere =
    num(listFilters.min) !== undefined || num(listFilters.max) !== undefined
      ? {
          unitCost: {
            ...(num(listFilters.min) !== undefined ? { gte: num(listFilters.min) } : {}),
            ...(num(listFilters.max) !== undefined ? { lte: num(listFilters.max) } : {}),
          },
        }
      : {};
  const fundingWhere =
    listFilters.funding === "PARTNER"
      ? { paidByPartnerId: { not: null } }
      : listFilters.funding === "TREASURY"
        ? { paidFromTreasury: true }
        : listFilters.funding === "NONE"
          ? { paidByPartnerId: null, paidFromTreasury: false }
          : {};
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
    ...(supplierFilter ? { supplierId: supplierFilter } : {}),
    ...(listFilters.partner ? { paidByPartnerId: listFilters.partner } : {}),
    ...dateWhere,
    ...costWhere,
    ...fundingWhere,
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
  // need a cheap existence check here, not the full catalog. Suppliers still
  // need a full fetch — the list's filter dropdown and the supplier-details
  // modal both need every supplier up front, not just search matches.
  const [productCount, suppliers, purchaseCount, purchases, partners, treasury, allCostQuantities] =
    await Promise.all([
      prisma.productVariant.count({ where: { product: { workspaceId: access.workspaceId } } }),
      prisma.supplier.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { name: "asc" },
        // full contact details so the table can show a supplier info modal
        select: { id: true, name: true, address: true, phone: true, altPhone: true, notes: true },
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
              attributes: true,
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
  // Filtered matches across all pages vs. every purchase in the workspace —
  // the second comes free from the total-spend fetch above.
  const matchCount = { shown: purchaseCount, total: allCostQuantities.length };

  const purchaseRows = purchases.map((pu) => ({
    id: pu.id,
    date: pu.date.toISOString().slice(0, 10),
    productVariantId: pu.productVariantId,
    product: variantFullName(pu.productVariant.product.name, pu.productVariant.attributes),
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
        count={purchaseCount}
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
        supplierFilter={supplierFilter}
        listFilters={listFilters}
        matchCount={matchCount}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(purchaseCount / PAGE_SIZE)}
        basePath={`/${slug}/purchases`}
        query={{
          q: q || undefined,
          sort: sort !== "date_desc" ? sort : undefined,
          supplier: supplierFilter || undefined,
          ...Object.fromEntries(
            Object.entries(listFilters).filter(([, v]) => v),
          ),
        }}
      />
    </div>
  );
}
