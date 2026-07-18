import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PurchaseManager } from "@/components/purchases/purchase-manager";

export default async function PurchasesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "purchases", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "purchases", "add", access.permissions),
    canEdit: can(access.role, "purchases", "edit", access.permissions),
  };

  const [products, suppliers, purchases] = await Promise.all([
    prisma.product.findMany({
      where: { workspaceId: access.workspaceId },
      include: { variants: true },
      orderBy: { name: "asc" },
    }),
    prisma.supplier.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.purchase.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { date: "desc" },
      take: 100,
      include: {
        supplier: { select: { name: true } },
        productVariant: {
          select: { size: true, color: true, product: { select: { name: true } } },
        },
      },
    }),
  ]);

  const variantOptions = products.flatMap((p) =>
    p.variants.map((v) => ({
      id: v.id,
      label:
        p.name +
        ([v.size, v.color].filter(Boolean).length
          ? ` (${[v.size, v.color].filter(Boolean).join(" / ")})`
          : ""),
      expiryTracked: p.expiryTracked,
    })),
  );

  const purchaseRows = purchases.map((pu) => ({
    id: pu.id,
    date: pu.date.toISOString().slice(0, 10),
    product:
      pu.productVariant.product.name +
      ([pu.productVariant.size, pu.productVariant.color].filter(Boolean).length
        ? ` (${[pu.productVariant.size, pu.productVariant.color].filter(Boolean).join(" / ")})`
        : ""),
    supplier: pu.supplier?.name ?? "—",
    unitCost: Number(pu.unitCost),
    quantity: pu.quantity,
    expiryDate: pu.expiryDate ? pu.expiryDate.toISOString().slice(0, 10) : null,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">Purchases</h1>
      <PurchaseManager
        slug={slug}
        variantOptions={variantOptions}
        suppliers={suppliers}
        purchases={purchaseRows}
        perms={perms}
      />
    </div>
  );
}
