"use server";

import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { variantStockMap } from "@/lib/inventory";

// Async-combobox data source. Each call returns one page of matches for a
// typed query plus an offset cursor. Offset (not keyset) pagination is fine
// here: the query already narrows the set hard, and users refine the search
// rather than paging deep. `next` is null once the last page is returned.
const SEARCH_PAGE_SIZE = 25;

export type ComboOption = { value: string; label: string };
export type VariantOption = ComboOption & {
  stock: number;
  expiryTracked: boolean;
  // Latest purchase unit cost — used to prefill auto-calculated costs (e.g.
  // product gifts) in forms; the server still snapshots authoritatively.
  unitCost: number;
  // Latest recorded per-piece sale price — prefills the order form's price box.
  salePrice: number | null;
  // >1 when the product is pack-based (enables Packet<->Piece form toggles).
  unitsPerPack: number | null;
};
export type SearchResult<T> =
  | { ok: true; items: T[]; next: number | null }
  | { ok: false; error: string };

function variantLabel(name: string, size: string | null, color: string | null) {
  const extra = [size, color].filter(Boolean).join(" / ");
  return extra ? `${name} (${extra})` : name;
}

/** Search product variants by product name / sku / size / color. */
export async function searchVariants(
  slug: string,
  query: string,
  cursor = 0,
): Promise<SearchResult<VariantOption>> {
  const gate = await requireAccess(slug, "products", "view");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const q = query.trim();
  const where = {
    product: { workspaceId },
    ...(q
      ? {
          OR: [
            { product: { name: { contains: q, mode: "insensitive" as const } } },
            { product: { sku: { contains: q, mode: "insensitive" as const } } },
            { sku: { contains: q, mode: "insensitive" as const } },
            { size: { contains: q, mode: "insensitive" as const } },
            { color: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const rows = await prisma.productVariant.findMany({
    where,
    orderBy: [{ product: { name: "asc" } }, { id: "asc" }],
    skip: cursor,
    take: SEARCH_PAGE_SIZE,
    select: {
      id: true,
      size: true,
      color: true,
      product: { select: { name: true, expiryTracked: true, unitsPerPack: true } },
    },
  });

  const ids = rows.map((r) => r.id);
  const [stock, latestPurchases] = await Promise.all([
    variantStockMap(workspaceId, ids),
    // Latest purchase per variant (distinct keeps the first row per variant
    // under the date-desc order) — the same cost the server snapshots on save.
    prisma.purchase.findMany({
      where: { workspaceId, productVariantId: { in: ids } },
      orderBy: [{ productVariantId: "asc" }, { date: "desc" }],
      distinct: ["productVariantId"],
      select: { productVariantId: true, unitCost: true, salePrice: true },
    }),
  ]);
  const latestByVariant = new Map(latestPurchases.map((p) => [p.productVariantId, p]));
  const items = rows.map((r) => {
    const latest = latestByVariant.get(r.id);
    return {
      value: r.id,
      label: variantLabel(r.product.name, r.size, r.color),
      stock: stock.get(r.id) ?? 0,
      expiryTracked: r.product.expiryTracked,
      unitCost: latest ? Number(latest.unitCost) : 0,
      salePrice: latest?.salePrice != null ? Number(latest.salePrice) : null,
      unitsPerPack: r.product.unitsPerPack,
    };
  });

  return {
    ok: true,
    items,
    next: rows.length === SEARCH_PAGE_SIZE ? cursor + SEARCH_PAGE_SIZE : null,
  };
}

/** Search customers by name / phone. */
export async function searchCustomers(
  slug: string,
  query: string,
  cursor = 0,
): Promise<SearchResult<ComboOption>> {
  const gate = await requireAccess(slug, "customers", "view");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const q = query.trim();
  const where = {
    workspaceId,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const rows = await prisma.customer.findMany({
    where,
    orderBy: { name: "asc" },
    skip: cursor,
    take: SEARCH_PAGE_SIZE,
    select: { id: true, name: true, phone: true },
  });

  const items = rows.map((r) => ({
    value: r.id,
    label: r.phone ? `${r.name} · ${r.phone}` : r.name,
  }));

  return {
    ok: true,
    items,
    next: rows.length === SEARCH_PAGE_SIZE ? cursor + SEARCH_PAGE_SIZE : null,
  };
}
