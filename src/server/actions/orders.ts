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
import {
  blockedByDepositedCash,
  codCollectable,
  depositAmount,
  syncOrderCashEntry,
} from "@/lib/order-cash";
import { computeOrderTotals } from "@/lib/orders";
import { isOrderSource } from "@/lib/order-source";
import { quoteCourier } from "@/lib/courier";
import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { failed, type ActionFailure } from "@/lib/form";
import { diffFields, newActivityGroup, recordActivity } from "@/lib/activity";
import { shipSnapshot } from "@/lib/order-recipient";
import { dhakaDateField } from "@/lib/date-field";

/**
 * How an order reads in the history — the same short id the breakdown page
 * shows, so a line in the activity list and the page it came from are
 * recognisably about the same order.
 */
function orderLabel(id: string, customerName: string | null | undefined): string {
  return `#${id.slice(-8).toUpperCase()} · ${customerName ?? "Walk-in"}`;
}

/**
 * The header fields worth a line in the history. Money and courier fields, not
 * the derived ones — a reader wants to know somebody changed the delivery cost
 * from 65 to 115, not that a total moved as a consequence.
 */
const HEADER_AUDIT_FIELDS = [
  "date",
  "customerId",
  "deliveryType",
  "deliveryCharge",
  "deliveryCost",
  "codFeeCost",
  "courierId",
  "courierZoneId",
  "shipName",
  "shipPhone",
  "shipAddress",
  "weightKg",
  "cancelledCollected",
  "paymentMethod",
  "packagingCost",
  "giftCost",
  "discount",
  "heldByMembershipId",
  "notes",
] as const;

const HEADER_AUDIT_SELECT = Object.fromEntries(
  HEADER_AUDIT_FIELDS.map((f) => [f, true]),
) as Record<(typeof HEADER_AUDIT_FIELDS)[number], true>;

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
  date: dhakaDateField,
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
  // Where this parcel goes, as agreed for THIS order. Blank means "same as the
  // customer record" and is stored as null, so a later correction to that
  // record still reaches the documents — see lib/order-recipient.
  shipName: z.string().trim().max(120).optional().or(z.literal("")),
  shipPhone: z.string().trim().max(40).optional().or(z.literal("")),
  shipAddress: z.string().trim().max(500).optional().or(z.literal("")),
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
    /**
     * What the courier will actually hand over — zero when it collects
     * nothing. Callers decide this with `codCollectable`; the fee follows the
     * money, and the money is not always the invoice.
     */
    codAmount: number;
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
    { zoneRate: Number(zone.rate), weightKg: input.weightKg ?? null, codAmount: input.codAmount },
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
    shipName: formData.get("shipName") ?? undefined,
    shipPhone: formData.get("shipPhone") ?? undefined,
    shipAddress: formData.get("shipAddress") ?? undefined,
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
          select: { id: true, name: true, phone: true, address: true },
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
    codAmount: codCollectable(d.paymentMethod, customerTotal),
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
    // The next number in this workspace's own sequence. Safe as max+1 because
    // the whole block is SERIALIZABLE — two people saving at once serialize,
    // and the unique index is the backstop if that ever stops being true.
    const highest = await tx.order.aggregate({
      where: { workspaceId },
      _max: { orderNo: true },
    });
    const created = await tx.order.create({
      data: {
        workspaceId,
        orderNo: (highest._max.orderNo ?? 0) + 1,
        customerId,
        date: d.date.at,
        dateHasTime: d.date.hasTime,
        status: d.status as OrderStatus,
        deliveryType: d.deliveryType,
        deliveryCharge: d.deliveryCharge,
        deliveryCost: courierQuote.deliveryCost,
        courierId: courierQuote.courierId,
        courierZoneId: courierQuote.courierZoneId,
        weightKg: d.weightKg ?? null,
        codFeeCost: courierQuote.codFeeCost,
        courierTrackingId: d.courierTrackingId?.trim() || null,
        // Only stored when it actually differs from the customer record.
        // Copying it every time would freeze a typo in place: correct the
        // customer later and the order would still print the old spelling.
        ...shipSnapshot(d, customer),
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

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "Order",
    entityId: order.id,
    entityLabel: orderLabel(order.id, customer?.name ?? null),
    summary: `Created — ${d.items.length} item(s), ${d.status.toLowerCase()}`,
  });

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
  date: dhakaDateField,
  deliveryType: z.enum(["SELF", "COURIER"]),
  deliveryCharge: z.coerce.number().nonnegative().default(0),
  deliveryCost: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  // Where this parcel goes, as agreed for THIS order. Blank means "same as the
  // customer record" and is stored as null, so a later correction to that
  // record still reaches the documents — see lib/order-recipient.
  shipName: z.string().trim().max(120).optional().or(z.literal("")),
  shipPhone: z.string().trim().max(40).optional().or(z.literal("")),
  shipAddress: z.string().trim().max(500).optional().or(z.literal("")),
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
      // Carries cancelledCollected among others, so a save that leaves the
      // partial-payment field alone still re-quotes the courier's fee against
      // the figure already stored.
      ...HEADER_AUDIT_SELECT,
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
  const before = order;

  const parsed = HeaderSchema.safeParse({
    customerId: formData.get("customerId") ?? undefined,
    date: formData.get("date"),
    deliveryType: formData.get("deliveryType"),
    deliveryCharge: formData.get("deliveryCharge"),
    deliveryCost: formData.get("deliveryCost") ?? undefined,
    shipName: formData.get("shipName") ?? undefined,
    shipPhone: formData.get("shipPhone") ?? undefined,
    shipAddress: formData.get("shipAddress") ?? undefined,
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
  let customer: { name: string; phone: string | null; address: string | null } | null = null;
  if (d.customerId) {
    const found = await prisma.customer.findFirst({
      where: { id: d.customerId, workspaceId },
      select: { id: true, name: true, phone: true, address: true },
    });
    if (!found) return { ok: false, error: "Customer not found" };
    customerId = found.id;
    customer = found;
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
  // changes with it. On a cancelled order it follows the partial payment
  // instead — editing that figure has to move the fee taken out of it.
  const itemsNet = order.items.reduce(
    (s, it) => s + Number(it.unitPrice) * it.quantity - Number(it.discount),
    0,
  );
  const collectable =
    order.status === "CANCELLED"
      ? (d.cancelledCollected ?? Number(order.cancelledCollected))
      : Math.max(0, itemsNet - d.discount + d.deliveryCharge);
  const courierQuote = await quoteForOrder(workspaceId, {
    courierId: d.courierId || undefined,
    courierZoneId: d.courierZoneId || undefined,
    weightKg: d.weightKg,
    deliveryCost: d.deliveryCost,
    codAmount: codCollectable(d.paymentMethod, collectable),
  });

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        customerId,
        heldByMembershipId,
        date: d.date.at,
        dateHasTime: d.date.hasTime,
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
        ...shipSnapshot(d, customer),
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

  // Read back rather than trusting the input: courierQuote can override the
  // delivery cost and the COD fee, so what was typed is not always what was
  // saved, and the history has to show what was saved.
  const after = await prisma.order.findUnique({
    where: { id: orderId },
    select: { ...HEADER_AUDIT_SELECT, customer: { select: { name: true } } },
  });
  const changes = after ? diffFields(before, after, [...HEADER_AUDIT_FIELDS]) : null;
  if (changes) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Order",
      entityId: orderId,
      entityLabel: orderLabel(orderId, after?.customer?.name),
      summary: "Order details edited",
      changes,
    });
  }

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
    include: {
      items: { include: { returns: true } },
      gifts: true,
      // Only for the history line — an order is named by its customer there.
      customer: { select: { name: true } },
    },
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

  // Cancelling changes what the courier has to hand over, so it changes the
  // percentage it keeps: a refused parcel yields only whatever was paid on the
  // doorstep, and un-cancelling puts the whole invoice back. Left alone, the
  // fee stored at order time went on describing a delivery that wasn't
  // happening — 9.60 taken out of a 120 partial payment that was quoted
  // against a 960 parcel.
  const collectable =
    status === "CANCELLED"
      ? (costs.cancelledCollected ?? Number(order.cancelledCollected))
      : computeOrderTotals(order).customerTotal;
  const { codFeeCost } = await quoteForOrder(workspaceId, {
    courierId: order.courierId ?? undefined,
    courierZoneId: order.courierZoneId ?? undefined,
    weightKg: order.weightKg != null ? Number(order.weightKg) : undefined,
    codAmount: codCollectable(order.paymentMethod, collectable),
  });

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
        data: { status: status as OrderStatus, ...costs, codFeeCost },
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

  // A cancellation is the one status change that carries money with it, and
  // the figures typed into the dialog are exactly the ones somebody asks about
  // later ("who said the courier charged 115?"), so they go in the line itself.
  const cancelDetail =
    status === "CANCELLED"
      ? [
          costs.cancelledCollected !== undefined
            ? `৳${costs.cancelledCollected} collected`
            : null,
          costs.deliveryCost !== undefined ? `৳${costs.deliveryCost} courier charge` : null,
          costs.giftCost ? `৳${costs.giftCost} gift` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: orderLabel(orderId, order.customer?.name),
    summary:
      status === "CANCELLED"
        ? `Cancelled${cancelDetail ? ` — ${cancelDetail}` : ""}`
        : `Status set to ${status.toLowerCase()}`,
    changes: {
      status: { from: order.status, to: status },
      ...(costs.deliveryCost !== undefined
        ? { deliveryCost: { from: Number(order.deliveryCost ?? 0), to: costs.deliveryCost } }
        : {}),
      ...(costs.cancelledCollected !== undefined
        ? {
            cancelledCollected: {
              from: Number(order.cancelledCollected),
              to: costs.cancelledCollected,
            },
          }
        : {}),
    },
  });

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
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
    },
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

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: orderLabel(orderId, order.customer?.name),
    summary:
      paymentStatus === "PARTIAL"
        ? `Payment set to partial — ৳${paid} received`
        : `Payment set to ${paymentStatus.toLowerCase()}`,
    changes: diffFields(
      { paymentStatus: order.paymentStatus, amountPaid: order.amountPaid },
      { paymentStatus, amountPaid: paid },
      ["paymentStatus", "amountPaid"],
    ),
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
    select: {
      id: true,
      deliveryType: true,
      courierTrackingId: true,
      customer: { select: { name: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (order.deliveryType !== "COURIER") {
    return { ok: false, error: "Only courier-delivery orders have a courier order number" };
  }

  const next = courierTrackingId.trim() || null;
  await prisma.order.update({
    where: { id: orderId },
    data: { courierTrackingId: next },
  });

  const changes = diffFields(order, { courierTrackingId: next }, ["courierTrackingId"]);
  if (changes) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Order",
      entityId: orderId,
      entityLabel: orderLabel(orderId, order.customer?.name),
      summary: next ? `Courier tracking ID set to ${next}` : "Courier tracking ID cleared",
      changes,
    });
  }

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
    include: {
      returns: true,
      // For the history line only: which order, and what was sent back.
      order: { select: { customer: { select: { name: true } } } },
      productVariant: {
        select: { attributes: true, product: { select: { name: true } } },
      },
    },
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

  // Filed against the ORDER, not the return row: somebody asking "why is this
  // order's profit lower than the invoice" is looking at the order's history,
  // and a return is the answer they need to find there.
  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "Order",
    entityId: item.orderId,
    entityLabel: orderLabel(item.orderId, item.order.customer?.name),
    summary:
      `Return recorded — ${d.quantity} × ` +
      `${variantFullName(item.productVariant.product.name, item.productVariant.attributes)}` +
      (d.refundAmount > 0 ? `, ৳${round2(d.refundAmount)} refunded` : ", no refund"),
  });

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
    select: {
      id: true,
      cashInTreasury: true,
      status: true,
      customer: { select: { name: true } },
      items: { select: { id: true } },
    },
  });
  if (!order) return { ok: true };
  const blocked = blockedByDepositedCash(order, "delete");
  if (blocked) return { ok: false, error: blocked };

  await prisma.order.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });

  // Deletion is the change with no record left to inspect afterwards, so the
  // line has to carry what the row was: after this, the history IS the order.
  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "Order",
    entityId: id,
    entityLabel: orderLabel(id, order.customer?.name),
    summary: `Deleted — was ${order.status.toLowerCase()}, ${order.items.length} item(s)`,
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

  const before = await prisma.order.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { source: true, customer: { select: { name: true } } },
  });
  const res = await prisma.order.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: { source },
  });
  if (res.count === 0) return { ok: false, error: "Order not found" };

  const sourceChanges = before ? diffFields(before, { source }, ["source"]) : null;
  if (sourceChanges) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Order",
      entityId: id,
      entityLabel: orderLabel(id, before?.customer?.name),
      summary: source ? `Came from set to ${source}` : "Came from cleared",
      changes: sourceChanges,
    });
  }

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

  const before = await prisma.order.findFirst({
    where: { id, workspaceId },
    select: { boostCampaignId: true, customer: { select: { name: true } } },
  });
  const res = await prisma.order.updateMany({
    where: { id, workspaceId },
    data: { boostCampaignId },
  });
  if (res.count === 0) return { ok: false, error: "Order not found" };

  const campaignChanges = before
    ? diffFields(before, { boostCampaignId }, ["boostCampaignId"])
    : null;
  if (campaignChanges) {
    // Attribution decides which campaign gets credit for the profit, so who
    // tagged what belongs in the history as much as any money field does.
    const name = boostCampaignId
      ? (await prisma.boostCampaign.findUnique({
          where: { id: boostCampaignId },
          select: { name: true },
        }))?.name
      : null;
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Order",
      entityId: id,
      entityLabel: orderLabel(id, before?.customer?.name),
      summary: name ? `Tagged to campaign ${name}` : "Campaign tag removed",
      changes: campaignChanges,
    });
  }

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/boosting`);
  if (boostCampaignId) revalidatePath(`/${slug}/boosting/${boostCampaignId}`);
  return { ok: true };
}
