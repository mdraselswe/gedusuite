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

export default async function ProductsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "products", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "products", "add", access.permissions),
    canEdit: can(access.role, "products", "edit", access.permissions),
  };

  const [products, suppliers, stock, adjustments] = await Promise.all([
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
    prisma.stockAdjustment.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { date: "desc" },
      take: 100,
      include: {
        productVariant: {
          select: { size: true, color: true, product: { select: { name: true } } },
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
    variants: p.variants.map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      sku: v.sku,
      stock: stock.get(v.id) ?? 0,
    })),
  }));

  const variantOptions = products.flatMap((p) =>
    p.variants.map((v) => ({
      id: v.id,
      label:
        p.name +
        ([v.size, v.color].filter(Boolean).length
          ? ` (${[v.size, v.color].filter(Boolean).join(" / ")})`
          : ""),
      stock: stock.get(v.id) ?? 0,
    })),
  );

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
      <h1 className="text-2xl font-bold">{(await serverT())("productsSuppliers")}</h1>
      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          <TabsTrigger value="adjustments">Stock adjustments</TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="pt-4">
          <ProductManager slug={slug} products={productData} perms={perms} />
        </TabsContent>
        <TabsContent value="suppliers" className="pt-4">
          <SupplierManager slug={slug} suppliers={suppliers} perms={perms} />
        </TabsContent>
        <TabsContent value="adjustments" className="pt-4">
          <StockAdjustmentManager
            slug={slug}
            variantOptions={variantOptions}
            adjustments={adjustmentRows}
            canEdit={perms.canEdit}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
