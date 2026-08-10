import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { serverT } from "@/lib/session";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals, orderNetProfit } from "@/lib/orders";
import { orderRecipient } from "@/lib/order-recipient";
import { amountOutstanding } from "@/lib/order-cash";
import { OrderManager } from "@/components/sales/order-manager";
import { variantFullName } from "@/lib/variants";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Receipt } from "lucide-react";

const PAGE_SIZE = 50;

const ORDER_STATUSES = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
const PAY_STATUSES = ["PAID", "UNPAID", "PARTIAL"] as const;
const DELIVERY_TYPES = ["SELF", "COURIER"] as const;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    page?: string;
    q?: string;
    status?: string;
    pay?: string;
    sort?: string;
    from?: string;
    to?: string;
    source?: string;
    held?: string;
    delivery?: string;
    /** Set by the call list's "+ Order" button. */
    fromLead?: string;
  }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? "").trim();
  const statusFilter = ORDER_STATUSES.includes(sp.status as never) ? sp.status : "";
  const payFilter = PAY_STATUSES.includes(sp.pay as never) ? sp.pay : "";
  const sort = sp.sort === "date_asc" ? "date_asc" : "date_desc";
  // Filters reach the database, not just the visible page — narrowing a
  // paginated list client-side would hide matches on every other page.
  const listFilters = {
    from: (sp.from ?? "").trim(),
    to: (sp.to ?? "").trim(),
    source: (sp.source ?? "").trim(),
    held: (sp.held ?? "").trim(),
    // Validated against the enum: an unknown value must narrow to nothing
    // rather than reach Prisma as a bare string.
    delivery: DELIVERY_TYPES.includes(sp.delivery as never) ? (sp.delivery as string) : "",
  };
  // A date-only string is midnight UTC, so the "to" end has to cover the
  // whole day or a same-day range would match nothing.
  const dateWhere =
    listFilters.from || listFilters.to
      ? {
          date: {
            ...(listFilters.from ? { gte: new Date(listFilters.from) } : {}),
            ...(listFilters.to ? { lte: new Date(`${listFilters.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {};
  const heldWhere =
    listFilters.held === "__none__"
      ? { heldByMembershipId: null }
      : listFilters.held
        ? { heldByMembershipId: listFilters.held }
        : {};
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
    ...(listFilters.source ? { source: listFilters.source } : {}),
    ...(listFilters.delivery
      ? { deliveryType: listFilters.delivery as (typeof DELIVERY_TYPES)[number] }
      : {}),
    ...dateWhere,
    ...heldWhere,
    ...(q
      ? {
          OR: [
            { customer: { name: { contains: q, mode: "insensitive" as const } } },
            // An order shipped under a different name has to be findable by
            // that name — it's the one on the parcel and on the invoice.
            { shipName: { contains: q, mode: "insensitive" as const } },
            { courierTrackingId: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [productCount, members, campaigns, courierRows, orderCount, totalOrderCount, orders] =
    await Promise.all([
    prisma.productVariant.count({ where: { product: { workspaceId } } }),
    prisma.membership.findMany({
      where: { workspaceId, role: { in: ["OWNER", "PARTNER"] } },
      include: { user: { select: { name: true, email: true } } },
    }),
    // Only campaigns still worth attributing to — a completed one's numbers
    // shouldn't keep moving. An order already tagged to a finished campaign
    // keeps its tag; the cell falls back to a plain label for those.
    prisma.boostCampaign.findMany({
      where: { workspaceId, status: { in: ["ACTIVE", "PAUSED"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
    // Rules the order form prices with. Inactive couriers are left out — the
    // form offers what's in use, while old orders keep whatever carried them.
    prisma.courier.findMany({
      where: { workspaceId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      include: { zones: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.order.count({ where }),
    // Unfiltered, for the bar's "showing N of M".
    prisma.order.count({ where: { workspaceId } }),
    prisma.order.findMany({
      where,
      orderBy: { date: sort === "date_asc" ? "asc" : "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { name: true, phone: true, address: true } },
        heldBy: { include: { user: { select: { name: true, email: true } } } },
        items: {
          include: {
            returns: true,
            productVariant: {
              select: { attributes: true, product: { select: { name: true } } },
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

  // Opened from a call-list row: hand the form what the caller already knows.
  // Read here rather than passed through the URL so a hand-edited link can't
  // put another workspace's lead — or made-up items — into the order form.
  const leadRow = sp.fromLead
    ? await prisma.orderLead.findFirst({
        where: { id: sp.fromLead, workspaceId },
        select: {
          id: true,
          customerName: true,
          phone: true,
          convertedCustomerId: true,
          itemsText: true,
          channel: true,
          address: true,
          total: true,
        },
      })
    : null;
  const fromLead = leadRow
    ? {
        leadId: leadRow.id,
        customerId: leadRow.convertedCustomerId,
        customerName: leadRow.customerName,
        phone: leadRow.phone,
        itemsText: leadRow.itemsText,
        channel: leadRow.channel,
        address: leadRow.address,
        total: Number(leadRow.total),
      }
    : null;

  const orderRows = orders.map((o) => {
    const totals = computeOrderTotals(o);
    return {
      id: o.id,
      date: o.date.toISOString().slice(0, 10),
      customerId: o.customerId,
      // The customer record's own name — what the customer picker shows, and
      // what "this buyer" means across their history.
      customerName: o.customer?.name ?? "Walk-in",
      // Who THIS parcel went to. Usually identical; different when a repeat
      // buyer sent one somewhere else, and then the list has to say so or the
      // order can't be found by the name it shipped under.
      recipientName: orderRecipient(o).name ?? "Walk-in",
      // Both halves, so the edit form can show what this parcel was addressed
      // to AND tell whether that differs from the customer record.
      customerPhone: o.customer?.phone ?? null,
      customerAddress: o.customer?.address ?? null,
      shipName: o.shipName,
      shipPhone: o.shipPhone,
      shipAddress: o.shipAddress,
      status: o.status,
      deliveryType: o.deliveryType,
      courierTrackingId: o.courierTrackingId,
      paymentStatus: o.paymentStatus,
      amountPaid: Number(o.amountPaid),
      // What is still owed after any advance — the number the list should show,
      // rather than the invoice total on an order that is half settled.
      amountDue: amountOutstanding(o, totals),
      paymentMethod: o.paymentMethod,
      source: o.source,
      boostCampaignId: o.boostCampaignId,
      cashInTreasury: o.cashInTreasury,
      deliveryCharge: Number(o.deliveryCharge),
      deliveryCost: o.deliveryCost !== null ? Number(o.deliveryCost) : null,
      courierId: o.courierId,
      courierZoneId: o.courierZoneId,
      weightKg: o.weightKg !== null ? Number(o.weightKg) : null,
      cancelledCollected: Number(o.cancelledCollected),
      packagingCost: Number(o.packagingCost),
      giftCost: Number(o.giftCost),
      discount: Number(o.discount),
      notes: o.notes,
      heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
      heldByMembershipId: o.heldByMembershipId,
      // `totals` is the sold-order math; its netProfit is right for everything
      // that was actually delivered and meaningless on a cancelled row, where
      // it reports the margin on goods that went back on the shelf. The list
      // shows the one figure the dashboard and the reports agree on.
      totals: { ...totals, netProfit: orderNetProfit(o) },
      gifts: o.gifts.map((g) => ({ label: g.label, quantity: g.quantity })),
      items: o.items.map((it) => {
        const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
        return {
          id: it.id,
          label: variantFullName(it.productVariant.product.name, it.productVariant.attributes),
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
      <PageHeader icon={<Receipt />} color="emerald" title={(await serverT())("salesOrders")} count={orderCount} />
      <OrderManager
        slug={slug}
        hasProducts={productCount > 0}
        members={memberOptions}
        campaigns={campaigns.map((c) => ({ id: c.id, label: c.name }))}
        couriers={courierRows.map((c) => ({
          id: c.id,
          name: c.name,
          isDefault: c.isDefault,
          baseWeightKg: Number(c.baseWeightKg),
          extraKgRate: Number(c.extraKgRate),
          codFeePercent: Number(c.codFeePercent),
          codFeeBase: c.codFeeBase,
          returnChargeType: c.returnChargeType,
          returnChargeValue: Number(c.returnChargeValue),
          zones: c.zones.map((z) => ({ id: z.id, name: z.name, rate: Number(z.rate) })),
        }))}
        fromLead={fromLead}
        orders={orderRows}
        perms={perms}
        query={q}
        statusFilter={statusFilter ?? ""}
        payFilter={payFilter ?? ""}
        sort={sort}
        listFilters={listFilters}
        matchCount={{ shown: orderCount, total: totalOrderCount }}
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
          ...Object.fromEntries(Object.entries(listFilters).filter(([, v]) => v)),
        }}
      />
    </div>
  );
}
