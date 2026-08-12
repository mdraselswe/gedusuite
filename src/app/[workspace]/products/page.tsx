import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { variantStockMap } from "@/lib/inventory";
import { variantFullName, variantAttributes } from "@/lib/variants";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProductManager } from "@/components/products/product-manager";
import { SupplierManager } from "@/components/products/supplier-manager";
import { StockAdjustmentManager } from "@/components/products/stock-adjustment-manager";
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

  const [products, suppliers, stock, adjustmentCount, adjustments, categories] = await Promise.all([
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
    })),
  }));

  const hasVariants = products.some((p) => p.variants.length > 0);

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
      <PageHeader icon={<Package />} color="violet" title={(await serverT())("productsSuppliers")} count={products.length} />
      <Tabs defaultValue={page > 1 ? "adjustments" : "products"}>
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          <TabsTrigger value="adjustments">Stock adjustments</TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="pt-4">
          <ProductManager
            slug={slug}
            products={productData}
            categories={categories}
            perms={perms}
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
