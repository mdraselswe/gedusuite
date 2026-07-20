import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PurchaseManager } from "@/components/purchases/purchase-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";

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

  const [products, suppliers, purchaseCount, purchases, partners] = await Promise.all([
    // No `select` here previously meant every product's imageUrl (up to ~1.4MB
    // base64 each) came along even though this page never renders images.
    prisma.product.findMany({
      where: { workspaceId: access.workspaceId },
      select: {
        id: true,
        name: true,
        expiryTracked: true,
        variants: { select: { id: true, size: true, color: true } },
      },
      orderBy: { name: "asc" },
    }),
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
          select: { size: true, color: true, product: { select: { name: true } } },
        },
      },
    }),
    prisma.partner.findMany({
      where: { workspaceId: access.workspaceId },
      select: { id: true, user: { select: { name: true, email: true } } },
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
    productVariantId: pu.productVariantId,
    product:
      pu.productVariant.product.name +
      ([pu.productVariant.size, pu.productVariant.color].filter(Boolean).length
        ? ` (${[pu.productVariant.size, pu.productVariant.color].filter(Boolean).join(" / ")})`
        : ""),
    supplierId: pu.supplierId,
    supplier: pu.supplier?.name ?? "—",
    paidByPartnerId: pu.paidByPartnerId,
    paidBy: pu.paidByPartner
      ? (pu.paidByPartner.user.name ?? pu.paidByPartner.user.email)
      : null,
    unitCost: Number(pu.unitCost),
    quantity: pu.quantity,
    expiryDate: pu.expiryDate ? pu.expiryDate.toISOString().slice(0, 10) : null,
  }));

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">{(await serverT())("purchases")}</h1>
      <PurchaseManager
        slug={slug}
        variantOptions={variantOptions}
        suppliers={suppliers}
        partnerOptions={partnerOptions}
        purchases={purchaseRows}
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
