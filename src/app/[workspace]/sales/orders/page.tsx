import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { variantStockMap } from "@/lib/inventory";
import { OrderManager } from "@/components/sales/order-manager";

function variantLabel(name: string, size: string | null, color: string | null) {
  const extra = [size, color].filter(Boolean).join(" / ");
  return extra ? `${name} (${extra})` : name;
}

export default async function OrdersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;

  const perms = {
    canAdd: can(access.role, "sales", "add", access.permissions),
    canEdit: can(access.role, "sales", "edit", access.permissions),
    canViewProfit: can(access.role, "reports", "view", access.permissions),
  };

  const [products, customers, members, stock, orders] = await Promise.all([
    // select (not include) — this page never renders images, so skip the
    // ~1.4MB-max base64 imageUrl column entirely instead of fetching it for
    // every product just to discard it.
    prisma.product.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        variants: { select: { id: true, size: true, color: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.customer.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.membership.findMany({
      where: { workspaceId, role: { in: ["OWNER", "PARTNER"] } },
      include: { user: { select: { name: true, email: true } } },
    }),
    variantStockMap(workspaceId),
    prisma.order.findMany({
      where: { workspaceId },
      orderBy: { date: "desc" },
      take: 100,
      include: {
        customer: { select: { name: true } },
        items: {
          include: {
            returns: true,
            productVariant: {
              select: { size: true, color: true, product: { select: { name: true } } },
            },
          },
        },
      },
    }),
  ]);

  const variantOptions = products.flatMap((p) =>
    p.variants.map((v) => ({
      id: v.id,
      label: variantLabel(p.name, v.size, v.color),
      stock: stock.get(v.id) ?? 0,
    })),
  );

  const memberOptions = members.map((m) => ({
    id: m.id,
    label: `${m.user.name ?? m.user.email} (${m.role})`,
  }));

  const orderRows = orders.map((o) => {
    const totals = computeOrderTotals(o);
    return {
      id: o.id,
      date: o.date.toISOString().slice(0, 10),
      customerName: o.customer?.name ?? "Walk-in",
      status: o.status,
      paymentStatus: o.paymentStatus,
      totals,
      items: o.items.map((it) => {
        const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
        return {
          id: it.id,
          label: variantLabel(
            it.productVariant.product.name,
            it.productVariant.size,
            it.productVariant.color,
          ),
          quantity: it.quantity,
          returnedQty: returned,
          remaining: it.quantity - returned,
          unitPrice: Number(it.unitPrice),
        };
      }),
    };
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold">{(await serverT())("salesOrders")}</h1>
      <OrderManager
        slug={slug}
        variantOptions={variantOptions}
        customers={customers}
        members={memberOptions}
        orders={orderRows}
        perms={perms}
      />
    </div>
  );
}
