import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { variantStockMap } from "@/lib/inventory";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProductManager } from "@/components/products/product-manager";
import { SupplierManager } from "@/components/products/supplier-manager";
import { StockAdjustmentManager } from "@/components/products/stock-adjustment-manager";
import { listProductCategories } from "@/server/actions/product-categories";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Package } from "lucide-react";

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
          select: { size: true, color: true, product: { select: { name: true } } },
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
    variants: p.variants.map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      sku: v.sku,
      stock: stock.get(v.id) ?? 0,
    })),
  }));

  const hasVariants = products.some((p) => p.variants.length > 0);

  const adjustmentRows = adjustments.map((a) => ({
    id: a.id,
    date: a.date.toISOString().slice(0, 10),
    product:
      a.productVariant.product.name +
      ([a.productVariant.size, a.productVariant.color].filter(Boolean).length
        ? ` (${[a.productVariant.size, a.productVariant.color].filter(Boolean).join(" / ")})`
        : ""),
    type: a.type,
    delta: a.delta,
    reason: a.reason,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader icon={<Package />} color="violet" title={(await serverT())("productsSuppliers")} />
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
