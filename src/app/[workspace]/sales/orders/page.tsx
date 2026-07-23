import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { OrderManager } from "@/components/sales/order-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Receipt } from "lucide-react";

const PAGE_SIZE = 50;

function variantLabel(name: string, size: string | null, color: string | null) {
  const extra = [size, color].filter(Boolean).join(" / ");
  return extra ? `${name} (${extra})` : name;
}

const ORDER_STATUSES = ["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
const PAY_STATUSES = ["PAID", "UNPAID", "PARTIAL"] as const;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; q?: string; status?: string; pay?: string; sort?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? "").trim();
  const statusFilter = ORDER_STATUSES.includes(sp.status as never) ? sp.status : "";
  const payFilter = PAY_STATUSES.includes(sp.pay as never) ? sp.pay : "";
  const sort = sp.sort === "date_asc" ? "date_asc" : "date_desc";
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

  // Products + customers are no longer bulk-loaded here — the order form's
  // product/customer pickers search them on demand (async combobox). We only
  // need a cheap existence check to gate the "add a product first" message.
  // Search/filter narrow the whole table server-side (all pages, not just the
  // visible one): customer name or courier tracking id, plus status filters.
  const where = {
    workspaceId,
    ...(statusFilter ? { status: statusFilter as (typeof ORDER_STATUSES)[number] } : {}),
    ...(payFilter ? { paymentStatus: payFilter as (typeof PAY_STATUSES)[number] } : {}),
    ...(q
      ? {
          OR: [
            { customer: { name: { contains: q, mode: "insensitive" as const } } },
            { courierTrackingId: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [productCount, members, orderCount, orders] = await Promise.all([
    prisma.productVariant.count({ where: { product: { workspaceId } } }),
    prisma.membership.findMany({
      where: { workspaceId, role: { in: ["OWNER", "PARTNER"] } },
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { date: sort === "date_asc" ? "asc" : "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { name: true } },
        heldBy: { include: { user: { select: { name: true, email: true } } } },
        items: {
          include: {
            returns: true,
            productVariant: {
              select: { size: true, color: true, product: { select: { name: true } } },
            },
          },
        },
        gifts: { select: { label: true, quantity: true } },
      },
    }),
  ]);

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
      deliveryType: o.deliveryType,
      courierTrackingId: o.courierTrackingId,
      paymentStatus: o.paymentStatus,
      paymentMethod: o.paymentMethod,
      heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
      totals,
      gifts: o.gifts.map((g) => ({ label: g.label, quantity: g.quantity })),
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
    <div className="space-y-6">
      <PageHeader icon={<Receipt />} color="emerald" title={(await serverT())("salesOrders")} />
      <OrderManager
        slug={slug}
        hasProducts={productCount > 0}
        members={memberOptions}
        orders={orderRows}
        perms={perms}
        query={q}
        statusFilter={statusFilter ?? ""}
        payFilter={payFilter ?? ""}
        sort={sort}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(orderCount / PAGE_SIZE)}
        basePath={`/${slug}/sales/orders`}
        query={{
          q: q || undefined,
          status: statusFilter || undefined,
          pay: payFilter || undefined,
          sort: sort !== "date_desc" ? sort : undefined,
        }}
      />
    </div>
  );
}
