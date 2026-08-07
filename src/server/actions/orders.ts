"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import {
  OutOfStock,
  refreshInventoryAlerts,
  variantStockMap,
  STOCK_CONSUMING_STATUSES,
} from "@/lib/inventory";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { variantFullName } from "@/lib/variants";
import { blockedByDepositedCash, depositAmount, syncOrderCashEntry } from "@/lib/order-cash";
import { computeOrderTotals } from "@/lib/orders";
import { isOrderSource } from "@/lib/order-source";
import { quoteCourier } from "@/lib/courier";
import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { failed, type ActionFailure } from "@/lib/form";

export type ActionResult =
  // `warning` is for things worth saying that aren't worth refusing over —
  // selling something with no cost on record, for one.
  | { ok: true; id?: string; warning?: string }
  | ActionFailure;

const CONSUMING: readonly string[] = STOCK_CONSUMING_STATUSES;

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

const ItemSchema = z.object({
  productVariantId: z.string().min(1),
  unitPrice: z.coerce.number().nonnegative(),
  quantity: z.coerce.number().int().positive(),
  discount: z.coerce.number().nonnegative().default(0),
});

// A gift is either product-linked (variant id; cost auto-snapshotted
// server-side unless the user typed their own — costOverridden) or custom
// free-text (label + manual cost, no stock effect).
const GiftSchema = z
  .object({
    productVariantId: z.string().optional().or(z.literal("")),
    label: z.string().trim().max(160).optional().or(z.literal("")),
    quantity: z.coerce.number().int().positive(),
    unitCost: z.coerce.number().nonnegative().default(0),
    costOverridden: z.coerce.boolean().default(false),
  })
  .refine((g) => g.productVariantId || g.label, {
    message: "Each gift needs a product or a name",
  });

const OrderSchema = z.object({
  customerId: z.string().optional().or(z.literal("")),
  date: z.coerce.date(),
  status: z.enum(["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"]),
  deliveryType: z.enum(["SELF", "COURIER"]),
  deliveryCharge: z.coerce.number().nonnegative().default(0),
  // Blank/omitted = assume it exactly equals deliveryCharge (pass-through).
  // Must strip "" before z.coerce.number() — Number("") is 0, not NaN, so an
  // empty field was silently coercing to a real 0 instead of "not provided".
  deliveryCost: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  // The courier's own order/consignment number — usually only known once the
  // courier is actually booked, so this is commonly filled in after the order
  // already exists (see updateCourierTrackingId below), not just at creation.
  courierTrackingId: z.string().trim().max(100).optional().or(z.literal("")),
  paymentMethod: z.enum(["CASH", "BKASH", "NAGAD", "COURIER_COLLECTION", "OTHER"]),
  paymentStatus: z.enum(["PAID", "UNPAID", "PARTIAL"]),
  /** Only read when paymentStatus is PARTIAL — how much the advance was. */
  amountPaid: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  packagingCost: z.coerce.number().nonnegative().default(0),
  giftCost: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  heldByMembershipId: z.string().optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // Which courier and zone carried it. Given these, the real cost — including
  // the percentage fee nobody remembers — is worked out server-side rather
  // than trusted from the form.
  courierId: z.string().optional().or(z.literal("")),
  courierZoneId: z.string().optional().or(z.literal("")),
  weightKg: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().max(1000).optional(),
  ),
  items: z.array(ItemSchema).min(1, "Add at least one item"),
  gifts: z.array(GiftSchema).default([]),
});

/**
 * What the courier will keep for this parcel.
 *
 * Recomputed here rather than taken from the form: the browser's preview is a
 * convenience, and a cost that decides profit has to come from the rules the
 * server holds. A typed deliveryCost still wins — couriers give one-off
 * discounts, and the person who paid the bill knows better than the table.
 */
async function quoteForOrder(
  workspaceId: string,
  input: {
    courierId?: string;
    courierZoneId?: string;
    weightKg?: number;
    deliveryCost?: number;
    codAmount: number;
    paymentMethod: string;
  },
): Promise<{ courierId: string | null; courierZoneId: string | null; deliveryCost: number | null; codFeeCost: number }> {
  const fallback = {
    courierId: null,
    courierZoneId: null,
    deliveryCost: input.deliveryCost ?? null,
    codFeeCost: 0,
  };
  if (!input.courierId || !input.courierZoneId) return fallback;

  const zone = await prisma.courierZone.findFirst({
    where: { id: input.courierZoneId, courierId: input.courierId, workspaceId },
    include: { courier: true },
  });
  if (!zone) return fallback;

  const quote = quoteCourier(
    {
      baseWeightKg: Number(zone.courier.baseWeightKg),
      extraKgRate: Number(zone.courier.extraKgRate),
      codFeePercent: Number(zone.courier.codFeePercent),
      codFeeBase: zone.courier.codFeeBase,
      returnChargeType: zone.courier.returnChargeType,
      returnChargeValue: Number(zone.courier.returnChargeValue),
    },
    {
      zoneRate: Number(zone.rate),
      weightKg: input.weightKg ?? null,
      // The fee is charged on money the COURIER collects — so the test is how
      // the customer pays, not whether the order has been settled yet. An
      // order paid by bKash in advance still travels by courier, but there is
      // nothing for it to collect and so no fee. (Payment status would be the
      // wrong test: every COD order is UNPAID at the moment it's created.)
      codAmount: input.paymentMethod === "COURIER_COLLECTION" ? input.codAmount : 0,
    },
  );

  return {
    courierId: zone.courierId,
    courierZoneId: zone.id,
    deliveryCost: input.deliveryCost ?? quote.deliveryCharge,
    codFeeCost: quote.codFee,
  };
}

/**
 * What each variant cost, snapshotted onto the order line at sale time.
 *
 * The most recent purchase price wins — this is a latest-cost model, not FIFO
 * or a weighted average. Buy at 100 and later at 120 and the older stock is
 * costed at 120 too. For a shop this size that's a fair trade for being able
 * to explain any line's cost from one visible record, but it is a choice, and
 * margins move with the last price paid.
 *
 * When nothing was ever purchased the variant's own catalogue cost stands in.
 * That fallback used to be a flat zero, which quietly reported the entire sale
 * price as profit: import a product, sell it before entering a purchase, and
 * the reports showed a 100% margin with nothing to suggest otherwise.
 */
async function latestCosts(
  workspaceId: string,
  variantIds: string[],
): Promise<Map<string, number>> {
  const uniqueIds = [...new Set(variantIds)];
  const map = new Map<string, number>();
  if (uniqueIds.length === 0) return map;

  const [purchases, variants] = await Promise.all([
    prisma.purchase.findMany({
      where: { workspaceId, productVariantId: { in: uniqueIds } },
      orderBy: [{ productVariantId: "asc" }, { date: "desc" }],
      select: { productVariantId: true, unitCost: true },
    }),
    prisma.productVariant.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, unitCost: true },
    }),
  ]);

  for (const p of purchases) {
    if (!map.has(p.productVariantId)) {
      map.set(p.productVariantId, Number(p.unitCost));
    }
  }
  // purchase -> catalogue cost -> 0, in that order.
  for (const v of variants) {
    if (!map.has(v.id) && v.unitCost != null) map.set(v.id, Number(v.unitCost));
  }
  for (const vid of uniqueIds) {
    if (!map.has(vid)) map.set(vid, 0);
  }
  return map;
}

/**
 * Which of these variants would be sold at zero cost — no purchase on record
 * and no catalogue cost either. The order still goes through (refusing a sale
 * because the paperwork is behind would be worse), but the seller is told,
 * because the alternative is a report claiming a margin nobody earned.
 */
async function zeroCostLabels(
  costs: Map<string, number>,
  variantIds: string[],
): Promise<string[]> {
  const zero = [...new Set(variantIds)].filter((id) => (costs.get(id) ?? 0) === 0);
  if (zero.length === 0) return [];
  const rows = await prisma.productVariant.findMany({
    where: { id: { in: zero } },
    select: { id: true, attributes: true, product: { select: { name: true } } },
  });
  return rows.map((v) => variantFullName(v.product.name, v.attributes));
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
  let giftsRaw: unknown = [];
  try {
    giftsRaw = JSON.parse(String(formData.get("gifts") ?? "[]"));
  } catch {
    giftsRaw = [];
  }
  const parsed = OrderSchema.safeParse({
    customerId: formData.get("customerId") ?? undefined,
    date: formData.get("date"),
    status: formData.get("status"),
    deliveryType: formData.get("deliveryType"),
    deliveryCharge: formData.get("deliveryCharge") ?? 0,
    deliveryCost: formData.get("deliveryCost") ?? undefined,
    courierTrackingId: formData.get("courierTrackingId") ?? undefined,
    paymentMethod: formData.get("paymentMethod"),
    paymentStatus: formData.get("paymentStatus"),
    amountPaid: formData.get("amountPaid") ?? undefined,
    packagingCost: formData.get("packagingCost") ?? 0,
    giftCost: formData.get("giftCost") ?? 0,
    discount: formData.get("discount") ?? 0,
    heldByMembershipId: formData.get("heldByMembershipId") ?? undefined,
    notes: formData.get("notes") ?? undefined,
    courierId: formData.get("courierId") ?? undefined,
    courierZoneId: formData.get("courierZoneId") ?? undefined,
    weightKg: formData.get("weightKg") ?? undefined,
    items: itemsRaw,
    gifts: giftsRaw,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;
  const giftVariantIds = d.gifts
    .map((g) => g.productVariantId)
    .filter((v): v is string => !!v);
  const variantIds = [...d.items.map((i) => i.productVariantId), ...giftVariantIds];

  // These 5 checks are all independent (none needs another's result) but were
  // previously awaited one after another — over a long-haul DB connection that
  // serializes ~300ms/round-trip into 1.5s+ before any real work starts.
  // Run them concurrently; total time = the slowest one, not the sum.
  const [validVariants, customer, heldByMember, stock, costs] = await Promise.all([
    prisma.productVariant.findMany({
      where: { id: { in: variantIds }, product: { workspaceId } },
      // Label fields are needed to snapshot a display name onto product-linked gifts.
      select: { id: true, attributes: true, product: { select: { name: true } } },
    }),
    d.customerId
      ? prisma.customer.findFirst({
          where: { id: d.customerId, workspaceId },
          select: { id: true, name: true },
        })
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
  // Product-linked gifts leave with the order too, so they count against stock.
  const byLabel = new Map(
    validVariants.map((v) => [v.id, variantFullName(v.product.name, v.attributes)]),
  );
  const need = new Map<string, number>();
  for (const it of d.items) {
    need.set(it.productVariantId, (need.get(it.productVariantId) ?? 0) + it.quantity);
  }
  for (const g of d.gifts) {
    if (g.productVariantId) {
      need.set(g.productVariantId, (need.get(g.productVariantId) ?? 0) + g.quantity);
    }
  }
  const short = [...need.entries()].filter(([vid, qty]) => (stock.get(vid) ?? 0) < qty);
  if (short.length > 0) {
    const labels = await prisma.productVariant.findMany({
      where: { id: { in: short.map(([vid]) => vid) } },
      select: {
        id: true,
        attributes: true,
        product: { select: { name: true } },
      },
    });
    const byId = new Map(labels.map((v) => [v.id, v]));
    const msg = short
      .map(([vid, qty]) => {
        const v = byId.get(vid);
        const name = v ? variantFullName(v.product.name, v.attributes) : "item";
        return `${name}: need ${qty}, ${stock.get(vid) ?? 0} in stock`;
      })
      .join("; ");
    return { ok: false, error: `Not enough stock — ${msg}` };
  }

  // Gift lines: product gifts get a server-side cost snapshot + label; custom
  // gifts keep their manual cost. Order.giftCost stores the summed total so all
  // existing profit/report math keeps working. When no gift lines are given,
  // the raw giftCost input still works (legacy manual amount).
  const variantById = new Map(validVariants.map((v) => [v.id, v]));
  const giftLines = d.gifts.map((g) => {
    const v = g.productVariantId ? variantById.get(g.productVariantId) : undefined;
    return {
      productVariantId: g.productVariantId || null,
      label: v ? variantFullName(v.product.name, v.attributes) : (g.label ?? "Gift"),
      quantity: g.quantity,
      // Product gifts default to the server-side cost snapshot; a user-typed
      // value (costOverridden) wins. Custom gifts are always manual.
      unitCost: v && !g.costOverridden ? (costs.get(v.id) ?? 0) : g.unitCost,
    };
  });
  const giftCost = giftLines.length
    ? round2(giftLines.reduce((s, g) => s + g.unitCost * g.quantity, 0))
    : d.giftCost;

  // Descriptive notification: who ordered, for how much. Mirrors the
  // customer-total math in computeOrderTotals for a fresh order (no returns).
  const itemsNet = d.items.reduce((s, it) => s + it.unitPrice * it.quantity - it.discount, 0);
  const customerTotal = round2(itemsNet - d.discount + d.deliveryCharge);
  const itemCount = d.items.reduce((s, it) => s + it.quantity, 0);
  const notifMessage = `New order — ${customer?.name ?? "Walk-in"} · ৳${customerTotal.toFixed(2)} (${itemCount} item${itemCount > 1 ? "s" : ""})`;

  // An advance can't be more than the order, and only means anything while the
  // order is part-paid — PAID already means all of it, UNPAID means none.
  let amountPaid = 0;
  if (d.paymentStatus === "PARTIAL") {
    if (!d.amountPaid || d.amountPaid <= 0) {
      return { ok: false, error: "Enter how much the customer has paid so far" };
    }
    if (round2(d.amountPaid) >= customerTotal) {
      return {
        ok: false,
        error: `That covers the whole order (${customerTotal.toFixed(2)}) — mark it paid instead`,
      };
    }
    amountPaid = round2(d.amountPaid);
  }

  const courierQuote = await quoteForOrder(workspaceId, {
    courierId: d.courierId || undefined,
    courierZoneId: d.courierZoneId || undefined,
    weightKg: d.weightKg,
    deliveryCost: d.deliveryCost,
    codAmount: customerTotal,
    paymentMethod: d.paymentMethod,
  });

  let order: { id: string };
  try {
    order = await runSerializable(async (tx) => {
    // Re-checked under SERIALIZABLE. Stock is derived, so there is no column
    // for a constraint to defend and no row to lock — only the isolation level
    // stops two people selling the same last piece. The check above ran
    // against a snapshot anyone could have moved since.
    const fresh = await variantStockMap(workspaceId, [...need.keys()], tx);
    for (const [vid, qty] of need) {
      if ((fresh.get(vid) ?? 0) < qty) throw new OutOfStock(byLabel.get(vid) ?? "item");
    }
    const created = await tx.order.create({
      data: {
        workspaceId,
        customerId,
        date: d.date,
        status: d.status as OrderStatus,
        deliveryType: d.deliveryType,
        deliveryCharge: d.deliveryCharge,
        deliveryCost: courierQuote.deliveryCost,
        courierId: courierQuote.courierId,
        courierZoneId: courierQuote.courierZoneId,
        weightKg: d.weightKg ?? null,
        codFeeCost: courierQuote.codFeeCost,
        courierTrackingId: d.courierTrackingId?.trim() || null,
        paymentMethod: d.paymentMethod,
        paymentStatus: d.paymentStatus,
        amountPaid,
        packagingCost: d.packagingCost,
        giftCost,
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
        gifts: { create: giftLines },
      },
    });
    await tx.notification.create({
      data: {
        workspaceId,
        type: "NEW_ORDER",
        message: notifMessage,
        link: `/${slug}/sales/orders/${created.id}/invoice`,
      },
    });
    return created;
    });
  } catch (e) {
    if (e instanceof OutOfStock || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  // Selling is how stock actually leaves, and it was the one path that never
  // recomputed the alerts: a purchase or a stock adjustment refreshed them,
  // a sale did not. Six pieces sold down to two sat there silently until
  // somebody happened to save an unrelated purchase.
  await refreshInventoryAlerts(workspaceId);

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);

  const noCost = await zeroCostLabels(costs, variantIds);
  return {
    ok: true,
    id: order.id,
    warning: noCost.length
      ? `Sold with no cost on record: ${noCost.join(", ")}. Their profit will read as the full sale price until a purchase is entered.`
      : undefined,
  };
}

// Header-only edit: the money/meta fields that commonly need correction after
// the fact. Items, gifts, status, payment status and courier id all have their
// own flows (stock and returns hang off items, so those stay out of here).
const HeaderSchema = z.object({
  customerId: z.string().optional().or(z.literal("")),
  date: z.coerce.date(),
  deliveryType: z.enum(["SELF", "COURIER"]),
  deliveryCharge: z.coerce.number().nonnegative().default(0),
  deliveryCost: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  paymentMethod: z.enum(["CASH", "BKASH", "NAGAD", "COURIER_COLLECTION", "OTHER"]),
  packagingCost: z.coerce.number().nonnegative().default(0),
  // Only used by an order with no gift lines — see the note where it's applied.
  giftCost: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // Who holds this order's cash. Was set-once at creation with no way back —
  // and the one field most likely to be wrong, since cash changes hands.
  heldByMembershipId: z.string().optional().or(z.literal("")),
  // Editable here too, not just at creation: orders entered before their
  // courier's rules existed have no zone, and a zone picked wrongly can only
  // be corrected where the order is corrected. Without this the only fix was
  // a script.
  courierId: z.string().optional().or(z.literal("")),
  courierZoneId: z.string().optional().or(z.literal("")),
  weightKg: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().max(1000).optional(),
  ),
  /** Only meaningful on a cancelled order — a partial delivery's takings. */
  cancelledCollected: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().max(99_999_999).optional(),
  ),
});

export async function updateOrderHeader(
  slug: string,
  orderId: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    select: {
      id: true,
      cashInTreasury: true,
      status: true,
      items: { select: { unitPrice: true, quantity: true, discount: true } },
      gifts: { select: { quantity: true, unitCost: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };

  const parsed = HeaderSchema.safeParse({
    customerId: formData.get("customerId") ?? undefined,
    date: formData.get("date"),
    deliveryType: formData.get("deliveryType"),
    deliveryCharge: formData.get("deliveryCharge"),
    deliveryCost: formData.get("deliveryCost") ?? undefined,
    paymentMethod: formData.get("paymentMethod"),
    packagingCost: formData.get("packagingCost"),
    giftCost: formData.get("giftCost"),
    discount: formData.get("discount"),
    notes: formData.get("notes") ?? undefined,
    heldByMembershipId: formData.get("heldByMembershipId") ?? undefined,
    courierId: formData.get("courierId") ?? undefined,
    courierZoneId: formData.get("courierZoneId") ?? undefined,
    weightKg: formData.get("weightKg") ?? undefined,
    cancelledCollected: formData.get("cancelledCollected") ?? undefined,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  let customerId: string | null = null;
  if (d.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: d.customerId, workspaceId },
      select: { id: true },
    });
    if (!customer) return { ok: false, error: "Customer not found" };
    customerId = customer.id;
  }

  // Checked against this workspace: the id comes from a form, and a
  // membership from elsewhere would otherwise be accepted by the FK.
  let heldByMembershipId: string | null = null;
  if (d.heldByMembershipId) {
    const member = await prisma.membership.findFirst({
      where: { id: d.heldByMembershipId, workspaceId },
      select: { id: true },
    });
    if (!member) return { ok: false, error: "Selected member is invalid" };
    heldByMembershipId = member.id;
  }

  // Order.giftCost is a stored total of the gift lines, and creation derives
  // it from them. Editing accepted a hand-typed number instead, so the order
  // could claim one gift cost while its own gift list added up to another —
  // and the breakdown page showed both. Derived here too; the typed value is
  // only honoured on an order that has no gift lines at all (the legacy shape,
  // where the amount is all there ever was).
  const giftCost = order.gifts.length
    ? round2(order.gifts.reduce((s, g) => s + Number(g.unitCost) * g.quantity, 0))
    : d.giftCost;

  // Re-quoted on every save, because the fee follows the order's value: change
  // the delivery charge or a discount and the percentage the courier keeps
  // changes with it. A cancelled order collected nothing to be charged on.
  const itemsNet = order.items.reduce(
    (s, it) => s + Number(it.unitPrice) * it.quantity - Number(it.discount),
    0,
  );
  const courierQuote = await quoteForOrder(workspaceId, {
    courierId: d.courierId || undefined,
    courierZoneId: d.courierZoneId || undefined,
    weightKg: d.weightKg,
    deliveryCost: d.deliveryCost,
    codAmount: Math.max(0, itemsNet - d.discount + d.deliveryCharge),
    paymentMethod: order.status === "CANCELLED" ? "" : d.paymentMethod,
  });

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        customerId,
        heldByMembershipId,
        date: d.date,
        deliveryType: d.deliveryType,
        deliveryCharge: d.deliveryCharge,
        deliveryCost: courierQuote.deliveryCost,
        courierId: courierQuote.courierId,
        courierZoneId: courierQuote.courierZoneId,
        weightKg: d.weightKg ?? null,
        codFeeCost: courierQuote.codFeeCost,
        ...(d.cancelledCollected !== undefined
          ? { cancelledCollected: d.cancelledCollected }
          : {}),
        paymentMethod: d.paymentMethod,
        packagingCost: d.packagingCost,
        giftCost,
        discount: d.discount,
        notes: d.notes?.trim() || null,
      },
    });
    // A changed charge or discount moves what the customer owes, so the
    // deposited-cash entry has to move with it.
    await syncOrderCashEntry(tx, workspaceId, orderId);
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * What a cancelled order still cost. All three are optional — an order
 * cancelled before anyone packed it has none of them, and leaving a field out
 * keeps whatever the order already had.
 */
const CancelCostSchema = z.object({
  packagingCost: z.coerce.number().nonnegative().max(99_999_999).optional(),
  giftCost: z.coerce.number().nonnegative().max(99_999_999).optional(),
  /** What the courier charged to bring the parcel back. */
  deliveryCost: z.coerce.number().nonnegative().max(99_999_999).optional(),
  /** What the customer paid anyway — a partial delivery, usually the shipping. */
  cancelledCollected: z.coerce.number().nonnegative().max(99_999_999).optional(),
});
export type CancelCosts = z.input<typeof CancelCostSchema>;

export async function updateOrderStatus(
  slug: string,
  orderId: string,
  status: string,
  cancelCosts?: CancelCosts,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const valid = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"];
  if (!valid.includes(status)) return { ok: false, error: "Invalid status" };

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: { items: true, gifts: true },
  });
  if (!order) return { ok: false, error: "Order not found" };

  // What a cancellation actually cost, captured at the moment it's cancelled
  // — the only moment anyone still knows whether the parcel was packed or
  // what the courier charged to bring it back. Omitted fields are left alone.
  let costs: {
    packagingCost?: number;
    giftCost?: number;
    deliveryCost?: number;
    cancelledCollected?: number;
  } = {};
  if (status === "CANCELLED" && cancelCosts) {
    const parsed = CancelCostSchema.safeParse(cancelCosts);
    if (!parsed.success) {
      return failed(parsed.error);
    }
    costs = parsed.data;
  }

  // Moving from non-consuming → consuming: verify stock is available. Checked
  // twice on purpose — here for a fast, friendly refusal before anything is
  // written, and again inside the transaction below where it actually binds.
  const wasConsuming = CONSUMING.includes(order.status);
  const willConsume = CONSUMING.includes(status);
  const needed = new Map<string, number>();
  if (!wasConsuming && willConsume) {
    for (const it of order.items) {
      needed.set(it.productVariantId, (needed.get(it.productVariantId) ?? 0) + it.quantity);
    }
    for (const g of order.gifts) {
      if (g.productVariantId) {
        needed.set(g.productVariantId, (needed.get(g.productVariantId) ?? 0) + g.quantity);
      }
    }
    const stock = await variantStockMap(workspaceId, [...needed.keys()]);
    for (const [vid, qty] of needed) {
      if ((stock.get(vid) ?? 0) < qty) {
        return { ok: false, error: "Not enough stock to confirm this order" };
      }
    }
  }
  const labelFor = new Map(
    (
      await prisma.productVariant.findMany({
        where: { id: { in: [...needed.keys()] } },
        select: { id: true, attributes: true, product: { select: { name: true } } },
      })
    ).map((v) => [v.id, variantFullName(v.product.name, v.attributes)]),
  );

  try {
    await runSerializable(async (tx) => {
      // Re-checked under SERIALIZABLE for the same reason as createOrder: the
      // snapshot above is only as fresh as the moment it was read.
      if (!wasConsuming && willConsume) {
        const fresh = await variantStockMap(workspaceId, [...needed.keys()], tx);
        for (const [vid, qty] of needed) {
          if ((fresh.get(vid) ?? 0) < qty) throw new OutOfStock(labelFor.get(vid) ?? "item");
        }
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: status as OrderStatus, ...costs },
      });
      // Cancelling sells nothing, so a deposited order's treasury entry drops
      // to whatever the customer paid anyway — or goes entirely.
      await syncOrderCashEntry(tx, workspaceId, orderId);
    });
  } catch (e) {
    if (e instanceof OutOfStock || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  // A status change moves stock in both directions — confirming consumes it,
  // cancelling puts it back — so the alerts have to be recomputed either way.
  await refreshInventoryAlerts(workspaceId);

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  // A cancellation moves profit (its packaging and courier charges) and the
  // channel's cancel rate, both of which the reports and campaign pages show.
  revalidatePath(`/${slug}/reports`);
  revalidatePath(`/${slug}/boosting`);
  return { ok: true };
}

/**
 * Update whether an order's payment has been collected — e.g. UNPAID -> PAID
 * once COD/courier-collection cash actually comes in. Doesn't touch stock;
 * unlike order status, payment status has no effect on inventory.
 *
 * PARTIAL now carries the figure with it. Without one the status said only
 * that "some" of the money had arrived, which no report could do anything with
 * — so the whole order stayed on the due list and the advance existed nowhere.
 */
export async function updatePaymentStatus(
  slug: string,
  orderId: string,
  paymentStatus: string,
  amountPaid?: number,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const valid = ["PAID", "UNPAID", "PARTIAL"];
  if (!valid.includes(paymentStatus)) return { ok: false, error: "Invalid payment status" };

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: { items: { include: { returns: true } } },
  });
  if (!order) return { ok: false, error: "Order not found" };

  // Going all the way back to UNPAID says nothing was collected after all,
  // which can't be true while the treasury holds a confirmed deposit for it.
  // Blocked rather than silently unwound: deleting a treasury entry is not
  // something a payment dropdown should do behind someone's back.
  //
  // PARTIAL is a different matter now that it carries a figure — the deposit
  // is recomputed from it below, the same way a recorded return shrinks it.
  // There is a real number to move to, so there is nothing to refuse.
  if (paymentStatus === "UNPAID") {
    const blocked = blockedByDepositedCash(order, "unpay");
    if (blocked) return { ok: false, error: blocked };
  }

  // A settled or untouched order carries no partial figure — cleared rather
  // than left lying around, so nothing downstream has to guess whether a
  // stale number still means anything.
  const totals = computeOrderTotals(order);
  let paid = 0;
  if (paymentStatus === "PARTIAL") {
    const total = totals.customerTotal;
    if (amountPaid == null || !Number.isFinite(amountPaid) || amountPaid <= 0) {
      return { ok: false, error: "Enter how much the customer has paid so far" };
    }
    if (round2(amountPaid) >= total) {
      return {
        ok: false,
        error: `That covers the whole order (${total.toFixed(2)}) — mark it paid instead`,
      };
    }
    paid = round2(amountPaid);
  }

  // Saying less was collected than the treasury is already holding for this
  // order takes money out of the balance — and a payment dropdown quietly
  // shrinking a confirmed deposit is the same thing blockedByDepositedCash
  // refuses to do for UNPAID, one step smaller. Going UP is unambiguous (more
  // money arrived) and syncs below without a word.
  if (order.cashInTreasury) {
    const banked = depositAmount(order, totals).net;
    const next = depositAmount(
      { ...order, paymentStatus, amountPaid: paid },
      totals,
    ).net;
    if (next < banked) {
      return {
        ok: false,
        error:
          `The treasury holds ${banked.toFixed(2)} for this order, and this would drop it to ` +
          `${next.toFixed(2)}. Undo the deposit on the order first — that removes the treasury ` +
          `entry — then set the payment and mark it deposited again.`,
      };
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: paymentStatus as PaymentStatus, amountPaid: paid },
    });
    // How much has been collected is precisely what a deposited entry holds,
    // so changing one has to move the other.
    await syncOrderCashEntry(tx, workspaceId, orderId);
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  revalidatePath(`/${slug}/treasury`);
  return { ok: true };
}

/** Set/clear the courier's own order number for a COURIER-delivery order. */
export async function updateCourierTrackingId(
  slug: string,
  orderId: string,
  courierTrackingId: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    select: { id: true, deliveryType: true },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (order.deliveryType !== "COURIER") {
    return { ok: false, error: "Only courier-delivery orders have a courier order number" };
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { courierTrackingId: courierTrackingId.trim() || null },
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
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
    return failed(parsed.error);
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

  // What these units were actually sold for, their share of the line discount
  // taken off. A refund is reported rather than subtracted — the returned unit
  // already drops out of revenue AND cost, so subtracting the cash again would
  // count the return twice — and that is exactly why an over-refund was
  // invisible: 5,000 handed back on a 500 item was accepted and showed up in no
  // total anywhere. Bounded here, at the only place that knows the line.
  const lineValue =
    (Number(item.unitPrice) - Number(item.discount) / Math.max(1, item.quantity)) * d.quantity;
  const maxRefund = round2(Math.max(0, lineValue));
  if (round2(d.refundAmount) > maxRefund) {
    return {
      ok: false,
      error:
        `A refund of ${round2(d.refundAmount).toFixed(2)} is more than these ${d.quantity} unit(s) ` +
        `were sold for (${maxRefund.toFixed(2)}). Enter what was actually handed back, or record ` +
        `the extra as a treasury payment so it shows up somewhere.`,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.return.create({
      data: {
        workspaceId,
        orderItemId: d.orderItemId,
        quantity: d.quantity,
        refundAmount: d.refundAmount,
        reason: d.reason?.trim() || null,
      },
    });
    // A returned unit lowers what the customer owed, so the cash confirmed
    // into the treasury for this order is no longer all the business's. The
    // refund shows as the deposit shrinking rather than as its own line —
    // money that never reached the treasury can't leave it.
    await syncOrderCashEntry(tx, workspaceId, item.orderId);
  });

  // Returned goods go back on the shelf, which can clear a low-stock alert.
  await refreshInventoryAlerts(workspaceId);

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deleteOrder(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;

  // TreasuryEntry.orderId is ON DELETE SET NULL, so deleting an order whose
  // cash was banked used to leave the entry behind with nothing attached — the
  // balance still counted it and nobody could say what it was for. Blocked
  // here rather than cleaned up, because neither cleanup is right: removing
  // the entry loses money that genuinely arrived, and keeping it loses the
  // trail. Undoing the deposit first is an explicit decision, and it needs
  // treasury rights that deleting an order does not.
  const order = await prisma.order.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { id: true, cashInTreasury: true },
  });
  if (!order) return { ok: true };
  const blocked = blockedByDepositedCash(order, "delete");
  if (blocked) return { ok: false, error: blocked };

  await prisma.order.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * Tag where an order came from.
 *
 * Deliberately its own action rather than a field on the order form: this way
 * the form and its submit path stay untouched, and existing orders can be
 * tagged after the fact from the list.
 *
 * Gated on sales:edit rather than sales:add — this is a correction to an
 * existing order, not creating one.
 */
export async function setOrderSource(
  slug: string,
  id: string,
  source: string | null,
): Promise<{ ok: true } | ActionFailure> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;

  // The column is a plain string, so nothing at the database level would
  // reject a typo — validate here instead.
  if (source !== null && !isOrderSource(source)) {
    return { ok: false, error: "Unknown order source" };
  }

  const res = await prisma.order.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: { source },
  });
  if (res.count === 0) return { ok: false, error: "Order not found" };

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/reports`);
  // The channel is half of how an untagged order is attributed to a campaign,
  // so a campaign's estimated result changes with it.
  revalidatePath(`/${slug}/boosting`);
  return { ok: true };
}

/**
 * Say which boosting campaign brought an order in — the exact half of
 * attribution, as against the window-and-channel estimate.
 *
 * Same shape as setOrderSource above, and for the same reason: tagging
 * happens from the list, so orders placed before a campaign existed can still
 * be attributed to it, and the order form stays untouched.
 */
export async function setOrderCampaign(
  slug: string,
  id: string,
  boostCampaignId: string | null,
): Promise<{ ok: true } | ActionFailure> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  // A campaign id from another workspace would otherwise be accepted by the
  // foreign key and leak one workspace's numbers into another's report.
  if (boostCampaignId !== null) {
    const campaign = await prisma.boostCampaign.findFirst({
      where: { id: boostCampaignId, workspaceId },
      select: { id: true },
    });
    if (!campaign) return { ok: false, error: "Campaign not found" };
  }

  const res = await prisma.order.updateMany({
    where: { id, workspaceId },
    data: { boostCampaignId },
  });
  if (res.count === 0) return { ok: false, error: "Order not found" };

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/boosting`);
  if (boostCampaignId) revalidatePath(`/${slug}/boosting/${boostCampaignId}`);
  return { ok: true };
}
