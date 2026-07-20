"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { variantStockMap, STOCK_CONSUMING_STATUSES } from "@/lib/inventory";
import type { OrderStatus, PaymentStatus } from "@prisma/client";

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

const CONSUMING: readonly string[] = STOCK_CONSUMING_STATUSES;

const ItemSchema = z.object({
  productVariantId: z.string().min(1),
  unitPrice: z.coerce.number().nonnegative(),
  quantity: z.coerce.number().int().positive(),
  discount: z.coerce.number().nonnegative().default(0),
});

const OrderSchema = z.object({
  customerId: z.string().optional().or(z.literal("")),
  date: z.coerce.date(),
  status: z.enum(["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"]),
  deliveryType: z.enum(["SELF", "COURIER"]),
  deliveryCharge: z.coerce.number().nonnegative().default(0),
  // Blank/omitted = assume it exactly equals deliveryCharge (pass-through).
  // Must strip "" before z.coerce.number() — Number("") is 0, not NaN, so an
  // empty field was silently coercing to a real 0 instead of "not provided".
  deliveryCost: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  paymentMethod: z.enum(["CASH", "BKASH", "NAGAD", "COURIER_COLLECTION", "OTHER"]),
  paymentStatus: z.enum(["PAID", "UNPAID", "PARTIAL"]),
  packagingCost: z.coerce.number().nonnegative().default(0),
  giftCost: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  heldByMembershipId: z.string().optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  items: z.array(ItemSchema).min(1, "Add at least one item"),
});

/** Latest purchase unit cost per variant (server-side cost snapshot). */
async function latestCosts(
  workspaceId: string,
  variantIds: string[],
): Promise<Map<string, number>> {
  const uniqueIds = [...new Set(variantIds)];
  const map = new Map<string, number>();
  if (uniqueIds.length === 0) return map;

  const purchases = await prisma.purchase.findMany({
    where: { workspaceId, productVariantId: { in: uniqueIds } },
    orderBy: [{ productVariantId: "asc" }, { date: "desc" }],
    select: { productVariantId: true, unitCost: true },
  });

  for (const p of purchases) {
    if (!map.has(p.productVariantId)) {
      map.set(p.productVariantId, Number(p.unitCost));
    }
  }
  for (const vid of uniqueIds) {
    if (!map.has(vid)) map.set(vid, 0);
  }
  return map;
}

export async function createOrder(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  let itemsRaw: unknown = [];
  try {
    itemsRaw = JSON.parse(String(formData.get("items") ?? "[]"));
  } catch {
    itemsRaw = [];
  }
  const parsed = OrderSchema.safeParse({
    customerId: formData.get("customerId") ?? undefined,
    date: formData.get("date"),
    status: formData.get("status"),
    deliveryType: formData.get("deliveryType"),
    deliveryCharge: formData.get("deliveryCharge") ?? 0,
    deliveryCost: formData.get("deliveryCost") ?? undefined,
    paymentMethod: formData.get("paymentMethod"),
    paymentStatus: formData.get("paymentStatus"),
    packagingCost: formData.get("packagingCost") ?? 0,
    giftCost: formData.get("giftCost") ?? 0,
    discount: formData.get("discount") ?? 0,
    heldByMembershipId: formData.get("heldByMembershipId") ?? undefined,
    notes: formData.get("notes") ?? undefined,
    items: itemsRaw,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const variantIds = d.items.map((i) => i.productVariantId);

  // These 5 checks are all independent (none needs another's result) but were
  // previously awaited one after another — over a long-haul DB connection that
  // serializes ~300ms/round-trip into 1.5s+ before any real work starts.
  // Run them concurrently; total time = the slowest one, not the sum.
  const [validVariants, customer, heldByMember, stock, costs] = await Promise.all([
    prisma.productVariant.findMany({
      where: { id: { in: variantIds }, product: { workspaceId } },
      select: { id: true },
    }),
    d.customerId
      ? prisma.customer.findFirst({ where: { id: d.customerId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
    d.heldByMembershipId
      ? prisma.membership.findFirst({
          where: { id: d.heldByMembershipId, workspaceId },
          select: { id: true },
        })
      : Promise.resolve(null),
    variantStockMap(workspaceId),
    latestCosts(workspaceId, variantIds),
  ]);

  if (validVariants.length !== new Set(variantIds).size) {
    return { ok: false, error: "One or more product variants are invalid" };
  }
  if (d.customerId && !customer) return { ok: false, error: "Customer not found" };
  if (d.heldByMembershipId && !heldByMember) {
    return { ok: false, error: "Selected member is invalid" };
  }
  const customerId = customer?.id ?? null;
  const heldByMembershipId = heldByMember?.id ?? null;

  // Never allow selling more than is currently in stock — server-side guard for
  // every order (not just consuming ones), with a clear, product-named error.
  const need = new Map<string, number>();
  for (const it of d.items) {
    need.set(it.productVariantId, (need.get(it.productVariantId) ?? 0) + it.quantity);
  }
  const short = [...need.entries()].filter(([vid, qty]) => (stock.get(vid) ?? 0) < qty);
  if (short.length > 0) {
    const labels = await prisma.productVariant.findMany({
      where: { id: { in: short.map(([vid]) => vid) } },
      select: {
        id: true,
        size: true,
        color: true,
        product: { select: { name: true } },
      },
    });
    const byId = new Map(labels.map((v) => [v.id, v]));
    const msg = short
      .map(([vid, qty]) => {
        const v = byId.get(vid);
        const extra = v ? [v.size, v.color].filter(Boolean).join(" / ") : "";
        const name = v ? `${v.product.name}${extra ? ` (${extra})` : ""}` : "item";
        return `${name}: need ${qty}, ${stock.get(vid) ?? 0} in stock`;
      })
      .join("; ");
    return { ok: false, error: `Not enough stock — ${msg}` };
  }

  // Batched in one round trip (array-form $transaction) since the notification
  // doesn't need the order's generated id.
  const [order] = await prisma.$transaction([
    prisma.order.create({
      data: {
        workspaceId,
        customerId,
        date: d.date,
        status: d.status as OrderStatus,
        deliveryType: d.deliveryType,
        deliveryCharge: d.deliveryCharge,
        deliveryCost: d.deliveryCost ?? null,
        paymentMethod: d.paymentMethod,
        paymentStatus: d.paymentStatus,
        packagingCost: d.packagingCost,
        giftCost: d.giftCost,
        discount: d.discount,
        heldByMembershipId,
        notes: d.notes?.trim() || null,
        items: {
          create: d.items.map((it) => ({
            productVariantId: it.productVariantId,
            unitPrice: it.unitPrice,
            unitCost: costs.get(it.productVariantId) ?? 0,
            quantity: it.quantity,
            discount: it.discount,
          })),
        },
      },
    }),
    prisma.notification.create({
      data: {
        workspaceId,
        type: "NEW_ORDER",
        message: `New order recorded (${d.items.length} item${d.items.length > 1 ? "s" : ""})`,
      },
    }),
  ]);

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true, id: order.id };
}

export async function updateOrderStatus(
  slug: string,
  orderId: string,
  status: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const valid = ["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];
  if (!valid.includes(status)) return { ok: false, error: "Invalid status" };

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: { items: true },
  });
  if (!order) return { ok: false, error: "Order not found" };

  // Moving from non-consuming → consuming: verify stock is available.
  const wasConsuming = CONSUMING.includes(order.status);
  const willConsume = CONSUMING.includes(status);
  if (!wasConsuming && willConsume) {
    const stock = await variantStockMap(workspaceId);
    const need = new Map<string, number>();
    for (const it of order.items) {
      need.set(it.productVariantId, (need.get(it.productVariantId) ?? 0) + it.quantity);
    }
    for (const [vid, qty] of need) {
      if ((stock.get(vid) ?? 0) < qty) {
        return { ok: false, error: "Not enough stock to confirm this order" };
      }
    }
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: status as OrderStatus },
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * Update whether an order's payment has been collected — e.g. UNPAID -> PAID
 * once COD/courier-collection cash actually comes in. Doesn't touch stock;
 * unlike order status, payment status has no effect on inventory.
 */
export async function updatePaymentStatus(
  slug: string,
  orderId: string,
  paymentStatus: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const valid = ["PAID", "UNPAID", "PARTIAL"];
  if (!valid.includes(paymentStatus)) return { ok: false, error: "Invalid payment status" };

  const res = await prisma.order.updateMany({
    where: { id: orderId, workspaceId },
    data: { paymentStatus: paymentStatus as PaymentStatus },
  });
  if (res.count === 0) return { ok: false, error: "Order not found" };

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/dashboard`);
  revalidatePath(`/${slug}/treasury`);
  return { ok: true };
}

const ReturnSchema = z.object({
  orderItemId: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  refundAmount: z.coerce.number().nonnegative().default(0),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

export async function createReturn(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = ReturnSchema.safeParse({
    orderItemId: formData.get("orderItemId"),
    quantity: formData.get("quantity"),
    refundAmount: formData.get("refundAmount") ?? 0,
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  const item = await prisma.orderItem.findFirst({
    where: { id: d.orderItemId, order: { workspaceId } },
    include: { returns: true },
  });
  if (!item) return { ok: false, error: "Order item not found" };

  const alreadyReturned = item.returns.reduce((s, r) => s + r.quantity, 0);
  if (d.quantity > item.quantity - alreadyReturned) {
    return { ok: false, error: "Return quantity exceeds remaining quantity" };
  }

  await prisma.return.create({
    data: {
      workspaceId,
      orderItemId: d.orderItemId,
      quantity: d.quantity,
      refundAmount: d.refundAmount,
      reason: d.reason?.trim() || null,
    },
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deleteOrder(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  await prisma.order.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
