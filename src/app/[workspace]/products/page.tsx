import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  inTransitReturnMap,
  variantCost,
  variantListPrice,
  variantStockMap,
} from "@/lib/inventory";
import { loadFlexibleComboVariants } from "@/lib/combo-variants";
import { recipeBuildable, withProductVariants } from "@/lib/flexible-combos";
import { componentsTotal } from "@/lib/combos";
import { round2 } from "@/lib/money";
import { variantFullName, variantAttributes } from "@/lib/variants";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ProductManager } from "@/components/products/product-manager";
import { SupplierManager } from "@/components/products/supplier-manager";
import { StockAdjustmentManager } from "@/components/products/stock-adjustment-manager";
import { ComboManager, type ComboRow } from "@/components/products/combo-manager";
import { listProductCategories } from "@/server/actions/product-categories";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Package } from "lucide-react";
import { dhakaRecordStamp } from "@/lib/dhaka-time";

const PAGE_SIZE = 50;

export default async function ProductsPage({
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
  if (!can(access.role, "products", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "products", "add", access.permissions),
    canEdit: can(access.role, "products", "edit", access.permissions),
  };
  const comboPerms = { ...perms, canDelete: can(access.role, "products", "full", access.permissions) };

  const [products, suppliers, stock, inTransit, adjustmentCount, adjustments, categories, combos] =
    await Promise.all([
    prisma.product.findMany({
      where: { workspaceId: access.workspaceId },
      include: { variants: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.supplier.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { name: "asc" },
    }),
    variantStockMap(access.workspaceId),
    // Not sellable and not lost: pieces a courier is bringing back. Shown
    // beside the stock figure so a 0 that has four coming on Thursday doesn't
    // send somebody to the supplier.
    inTransitReturnMap(access.workspaceId),
    prisma.stockAdjustment.count({ where: { workspaceId: access.workspaceId } }),
    prisma.stockAdjustment.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { date: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        productVariant: {
          select: { attributes: true, product: { select: { name: true } } },
        },
      },
    }),
    listProductCategories(slug),
    // Combos carry the variant's last purchase cost as well as its catalogue
    // one, because the margin shown against a combo has to agree with the cost
    // its order lines will actually snapshot — see variantCost.
    prisma.comboSet.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        items: {
          include: {
            productVariant: {
              select: {
                id: true,
                productId: true,
                attributes: true,
                salePrice: true,
                unitCost: true,
                wooProductId: true,
                product: { select: { name: true } },
                purchases: {
                  orderBy: { date: "desc" },
                  take: 1,
                  select: { unitCost: true, salePrice: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const productData = products.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    sku: p.sku,
    barcode: p.barcode,
    imageUrl: p.imageUrl,
    expiryTracked: p.expiryTracked,
    lowStockThreshold: p.lowStockThreshold,
    unitsPerPack: p.unitsPerPack,
    weightGrams: p.weightGrams,
    attributeNames: Array.isArray(p.attributeNames)
      ? (p.attributeNames.filter((n): n is string => typeof n === "string"))
      : [],
    variants: p.variants.map((v) => ({
      id: v.id,
      attributes: variantAttributes(v.attributes),
      sku: v.sku,
      barcode: v.barcode,
      description: v.description,
      imageUrl: v.imageUrl,
      salePrice: v.salePrice != null ? Number(v.salePrice) : null,
      unitCost: v.unitCost != null ? Number(v.unitCost) : null,
      lowStockThreshold: v.lowStockThreshold,
      stock: stock.get(v.id) ?? 0,
      inTransit: inTransit.get(v.id) ?? 0,
    })),
  }));

  const hasVariants = products.some((p) => p.variants.length > 0);

  const siblings = await loadFlexibleComboVariants(access.workspaceId, combos);
  const comboRows: ComboRow[] = combos.map((c) => {
    const components = c.items.map((i) => ({
      productVariantId: i.productVariantId,
      productId: i.productVariant.productId,
      productName: i.productVariant.product.name,
      label: variantFullName(i.productVariant.product.name, i.productVariant.attributes),
      quantity: i.quantity,
      // Same rule the combo form uses, so opening a combo to edit it can't show
      // a different "bought separately" than building it did.
      salePrice: variantListPrice(i.productVariant),
      unitCost: variantCost(i.productVariant),
      stock: stock.get(i.productVariantId) ?? 0,
      wooProductId: i.productVariant.wooProductId,
    }));
    return {
      id: c.id,
      name: c.name,
      sku: c.sku,
      price: Number(c.price),
      freeDelivery: c.freeDelivery,
      flexibleVariants: c.flexibleVariants,
      active: c.active,
      wooProductId: c.wooProductId,
      validFrom: c.validFrom?.toISOString() ?? null,
      validTo: c.validTo?.toISOString() ?? null,
      // Derived from the same stock map the variant rows above are showing, so
      // "12 sets" and the pieces it counted can never tell different stories.
      buildable: recipeBuildable(withProductVariants(components, siblings, c.flexibleVariants), stock, c.flexibleVariants),
      listTotal: componentsTotal(components),
      costTotal: round2(components.reduce((s, k) => s + k.unitCost * k.quantity, 0)),
      components,
    };
  });

  const adjustmentRows = adjustments.map((a) => ({
    id: a.id,
    ...dhakaRecordStamp(a.date, a.createdAt, a.dateHasTime),
    product: variantFullName(a.productVariant.product.name, a.productVariant.attributes),
    type: a.type,
    delta: a.delta,
    reason: a.reason,
  }));

  return (
    <div className="space-y-6">
      {/* No count pill here any more — a single number next to the title
          could only ever describe one of the four tabs below it, and stayed
          on screen (unchanged, and wrong) no matter which tab was open. Each
          tab now carries its own. */}
      <PageHeader icon={<Package />} color="violet" title={(await serverT())("productsSuppliers")} />
      <Tabs defaultValue={page > 1 ? "adjustments" : "products"}>
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="products">
            Products <Badge variant="secondary" className="ml-1.5 tabular-nums">{products.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="combos">
            Combos <Badge variant="secondary" className="ml-1.5 tabular-nums">{comboRows.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="suppliers">
            Suppliers <Badge variant="secondary" className="ml-1.5 tabular-nums">{suppliers.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="adjustments">
            Stock adjustments <Badge variant="secondary" className="ml-1.5 tabular-nums">{adjustmentCount}</Badge>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="pt-4">
          <ProductManager
            slug={slug}
            products={productData}
            categories={categories}
            perms={perms}
          />
        </TabsContent>
        <TabsContent value="combos" className="pt-4">
          <ComboManager
            slug={slug}
            combos={comboRows}
            hasProducts={hasVariants}
            perms={comboPerms}
          />
        </TabsContent>
        <TabsContent value="suppliers" className="pt-4">
          <SupplierManager slug={slug} suppliers={suppliers} perms={perms} />
        </TabsContent>
        <TabsContent value="adjustments" className="pt-4">
          <StockAdjustmentManager
            slug={slug}
            hasProducts={hasVariants}
            adjustments={adjustmentRows}
            canEdit={perms.canEdit}
          />
          <div className="mt-4">
            <Pagination
              page={page}
              totalPages={Math.ceil(adjustmentCount / PAGE_SIZE)}
              basePath={`/${slug}/products`}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
