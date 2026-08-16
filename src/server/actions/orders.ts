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
  amountCollected,
  applyPayment,
  blockedByDepositedCash,
  codBaseFor,
  codCollectable,
  depositAmount,
  syncOrderCashEntry,
} from "@/lib/order-cash";
import { computeOrderTotals, goodsDiscount } from "@/lib/orders";
import { isOrderSource } from "@/lib/order-source";
import { quoteCourier } from "@/lib/courier";
import { syncCourierStatuses } from "@/lib/courier-status-sync";
import type { OrderStatus, PaymentStatus, Prisma, ReturnLeg } from "@prisma/client";
import { checkboxField, failed, type ActionFailure } from "@/lib/form";
import { diffFields, newActivityGroup, recordActivity } from "@/lib/activity";
import { shipSnapshot } from "@/lib/order-recipient";
import { dhakaDateField } from "@/lib/date-field";
import { returnShortfalls } from "@/lib/returns";
import { round2 } from "@/lib/money";

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
  // Editable from the same dialog, and worth a history line for the same
  // reason the money fields are: it decides whether a parcel's pieces are
  // sellable, and somebody will want to know who said so.
  "returnLeg",
  "paymentMethod",
  "packagingCost",
  "giftCost",
  "discount",
  "isGiveaway",
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

/**
 * Whether this order is holding its units off the shelf — the same rule
 * `variantStockMap` derives stock by, so the two cannot disagree about whether
 * confirming an order needs stock it has already taken.
 */
function isOffShelf(o: { status: string; returnLeg: ReturnLeg }): boolean {
  return (
    CONSUMING.includes(o.status) || (o.status === "CANCELLED" && o.returnLeg === "IN_TRANSIT")
  );
}


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
  /**
   * The goods are a gift. What the customer pays for them is worked out here
   * rather than typed — see `goodsDiscount`.
   */
  isGiveaway: checkboxField,
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
    include: { courier: true, bands: { select: { uptoKg: true, rate: true } } },
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
      bands: zone.bands.map((b) => ({ uptoKg: Number(b.uptoKg), rate: Number(b.rate) })),
      weightKg: input.weightKg ?? null,
      codAmount: input.codAmount,
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
    shipName: formData.get("shipName") ?? undefined,
    shipPhone: formData.get("shipPhone") ?? undefined,
    shipAddress: formData.get("shipAddress") ?? undefined,
    paymentMethod: formData.get("paymentMethod"),
    paymentStatus: formData.get("paymentStatus"),
    amountPaid: formData.get("amountPaid") ?? undefined,
    packagingCost: formData.get("packagingCost") ?? 0,
    giftCost: formData.get("giftCost") ?? 0,
    discount: formData.get("discount") ?? 0,
    isGiveaway: formData.get("isGiveaway"),
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
  const discount = goodsDiscount(d.isGiveaway, d.discount, itemsNet);
  const customerTotal = round2(itemsNet - discount + d.deliveryCharge);
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
    // A fresh order has nothing returned and nothing missing, so this figure
    // IS the invoiced total codBaseFor works from on every later save.
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
        discount,
        isGiveaway: d.isGiveaway,
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
  /** The goods are a gift — see `goodsDiscount`. */
  isGiveaway: checkboxField,
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
  /**
   * The way back into the return queue for a cancellation that was recorded
   * without it — the box unticked by mistake, or an order cancelled before
   * ReturnLeg existed at all.
   *
   * Two fields for one answer, because an unticked checkbox posts nothing at
   * all: without the marker, "the goods are back" and "this form never asked"
   * arrive identically, and every header edit on every other order would
   * silently release a parcel that is still in a van.
   */
  goodsInTransitAsked: checkboxField.default(false),
  goodsInTransit: checkboxField.default(false),
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
      items: {
        select: {
          unitPrice: true,
          quantity: true,
          discount: true,
          // Only needed when the return leg is being turned on, which takes
          // these units off the shelf and so has to be able to check them.
          productVariantId: true,
        },
      },
      gifts: { select: { quantity: true, unitCost: true, productVariantId: true } },
      // Not edited here, but the courier's fee is quoted net of it — without
      // it a header save re-quoted on the full invoice and quietly undid the
      // correction recordCollectedAmount had made.
      collectionShortfall: true,
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
    isGiveaway: formData.get("isGiveaway"),
    notes: formData.get("notes") ?? undefined,
    heldByMembershipId: formData.get("heldByMembershipId") ?? undefined,
    courierId: formData.get("courierId") ?? undefined,
    courierZoneId: formData.get("courierZoneId") ?? undefined,
    weightKg: formData.get("weightKg") ?? undefined,
    cancelledCollected: formData.get("cancelledCollected") ?? undefined,
    goodsInTransitAsked: formData.get("goodsInTransitAsked"),
    goodsInTransit: formData.get("goodsInTransit"),
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
  const discount = goodsDiscount(d.isGiveaway, d.discount, itemsNet);
  // Built from the values being saved, not the stored ones — this edit may be
  // changing the discount or the delivery charge, and the fee follows. Returns
  // don't enter into it: this is the invoice the courier collected against.
  const invoicedTotal = round2(itemsNet - discount + d.deliveryCharge);
  const collectable = codBaseFor(
    {
      status: order.status,
      cancelledCollected: d.cancelledCollected ?? order.cancelledCollected,
      collectionShortfall: order.collectionShortfall,
    },
    { invoicedTotal },
  );
  const courierQuote = await quoteForOrder(workspaceId, {
    courierId: d.courierId || undefined,
    courierZoneId: d.courierZoneId || undefined,
    weightKg: d.weightKg,
    deliveryCost: d.deliveryCost,
    codAmount: codCollectable(d.paymentMethod, collectable),
  });

  /**
   * Where the goods end up once this save lands.
   *
   * Ignored unless the dialog asked, and it only asks on a cancelled order
   * whose leg is still open — RECEIVED and LOST are settled by an action that
   * wrote stock adjustments, and letting a header edit reopen them would leave
   * those adjustments describing a parcel that is no longer written off.
   */
  const legEditable =
    order.status === "CANCELLED" && (order.returnLeg === "NONE" || order.returnLeg === "IN_TRANSIT");
  const returnLeg: ReturnLeg =
    d.goodsInTransitAsked && legEditable
      ? d.goodsInTransit
        ? "IN_TRANSIT"
        : "NONE"
      : order.returnLeg;
  const legChanged = returnLeg !== order.returnLeg;

  // Turning the leg ON takes these pieces off the shelf, so it can drive stock
  // negative exactly as confirming an order can. Checked here rather than in a
  // serializable block: this is a correction somebody makes by hand on one
  // order, not a path two people race down for the same last piece.
  if (legChanged && returnLeg === "IN_TRANSIT") {
    const needed = new Map<string, number>();
    for (const it of order.items) {
      needed.set(it.productVariantId, (needed.get(it.productVariantId) ?? 0) + it.quantity);
    }
    for (const g of order.gifts) {
      if (!g.productVariantId) continue;
      needed.set(g.productVariantId, (needed.get(g.productVariantId) ?? 0) + g.quantity);
    }
    const stock = await variantStockMap(workspaceId, [...needed.keys()]);
    for (const [vid, qty] of needed) {
      if ((stock.get(vid) ?? 0) < qty) {
        return {
          ok: false,
          error:
            "There isn't enough stock to hold this parcel out — some of it has already been sold. " +
            "Correct the stock first, then mark the goods as still with the courier.",
        };
      }
    }
  }

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
        ...(legChanged
          ? {
              returnLeg,
              returnLegAt: returnLeg === "NONE" ? null : new Date(),
            }
          : {}),
        ...shipSnapshot(d, customer),
        paymentMethod: d.paymentMethod,
        packagingCost: d.packagingCost,
        giftCost,
        discount,
        isGiveaway: d.isGiveaway,
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

  // The return leg is the only thing this dialog edits that moves stock —
  // everything else on it is money.
  if (legChanged) {
    await refreshInventoryAlerts(workspaceId);
    revalidatePath(`/${slug}/products`);
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
  /**
   * The goods are with the courier and haven't come back yet, so they stay off
   * the shelf until somebody says they've arrived (see ReturnLeg).
   *
   * Asked rather than inferred. The status says the parcel was shipped; it
   * doesn't say whether the rider already handed it back at the door, and the
   * two lead to opposite answers about what is sellable this afternoon.
   */
  // A real boolean, not z.coerce.boolean(): the dialog hands this over as one,
  // and coercion would read the string "false" as true.
  goodsInTransit: z.boolean().optional(),
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
  // Where the goods are, which is a different question from where the money
  // is. Only a cancellation has an answer other than "with us".
  let goodsInTransit = false;
  if (status === "CANCELLED" && cancelCosts) {
    const parsed = CancelCostSchema.safeParse(cancelCosts);
    if (!parsed.success) {
      return failed(parsed.error);
    }
    const { goodsInTransit: inTransit, ...money } = parsed.data;
    costs = money;
    goodsInTransit = inTransit ?? false;
  }
  /**
   * The return leg this status change leaves behind.
   *
   * Anything that is not a cancellation ends it: un-cancelling an order means
   * the parcel is this order's again, not a return waiting to be received.
   * Re-cancelling an order that is ALREADY out for return keeps the leg where
   * it is — re-typing the courier's charge must not quietly put stock back.
   */
  const returnLeg: ReturnLeg =
    status !== "CANCELLED"
      ? "NONE"
      : order.status === "CANCELLED"
        ? order.returnLeg
        : goodsInTransit
          ? "IN_TRANSIT"
          : "NONE";
  const legChanged = returnLeg !== order.returnLeg;

  // Cancelling changes what the courier has to hand over, so it changes the
  // percentage it keeps: a refused parcel yields only whatever was paid on the
  // doorstep, and un-cancelling puts the whole invoice back. Left alone, the
  // fee stored at order time went on describing a delivery that wasn't
  // happening — 9.60 taken out of a 120 partial payment that was quoted
  // against a 960 parcel.
  // The invoice, not `customerTotal`. This used to read the returns-aware
  // figure while the header edit read the invoice, so an order with a return
  // stored a different fee depending on which of the two was saved last. The
  // courier took its cut at the door, before anything came back.
  const collectable = codBaseFor(
    {
      status,
      cancelledCollected: costs.cancelledCollected ?? order.cancelledCollected,
      collectionShortfall: order.collectionShortfall,
    },
    computeOrderTotals(order),
  );
  const { codFeeCost } = await quoteForOrder(workspaceId, {
    courierId: order.courierId ?? undefined,
    courierZoneId: order.courierZoneId ?? undefined,
    weightKg: order.weightKg != null ? Number(order.weightKg) : undefined,
    codAmount: codCollectable(order.paymentMethod, collectable),
  });

  // Money collected on a refused parcel IS money the customer paid, and the
  // cancel dialog is the only place it gets typed. Writing it to
  // `cancelledCollected` alone left the order still reading UNPAID with 130
  // taka of the customer's money against it — every money figure downstream was
  // right (they all consult `cancelledCollected` once an order is cancelled)
  // and the badge on the list said the opposite. Recording a partial payment
  // BEFORE cancelling produced the correct pair, so the same order looked
  // different depending on which order the two steps happened in.
  //
  // PAID is left alone: a prepaid order that gets cancelled has been paid in
  // full, and what happens to that money is a refund, not a payment status.
  const collectedOnCancel =
    status === "CANCELLED" ? (costs.cancelledCollected ?? Number(order.cancelledCollected)) : 0;
  const settlement =
    collectedOnCancel > 0 && order.paymentStatus !== "PAID"
      ? { paymentStatus: "PARTIAL" as const, amountPaid: collectedOnCancel }
      : {};

  // Moving from non-consuming → consuming: verify stock is available. Checked
  // twice on purpose — here for a fast, friendly refusal before anything is
  // written, and again inside the transaction below where it actually binds.
  //
  // "Off the shelf" rather than "consuming", because a cancelled parcel still
  // travelling back is already holding its units out of stock. Reviving one
  // needs no stock at all — it never went back — and asking for it refused to
  // un-cancel any order whose own pieces were the last ones left.
  const wasConsuming = isOffShelf(order);
  const willConsume = CONSUMING.includes(status) || returnLeg === "IN_TRANSIT";
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
        data: {
          status: status as OrderStatus,
          ...costs,
          ...settlement,
          codFeeCost,
          returnLeg,
          // Stamped only when the leg actually moves, so "sent back on the
          // 14th" survives somebody re-opening the dialog to fix a charge.
          ...(legChanged ? { returnLegAt: returnLeg === "NONE" ? null : new Date() } : {}),
        },
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
          // Worth its own words: it is the difference between the goods being
          // back on the shelf tonight and them being somewhere in a van.
          returnLeg === "IN_TRANSIT" ? "goods still with the courier" : null,
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
      ...(legChanged ? { returnLeg: { from: order.returnLeg, to: returnLeg } } : {}),
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

const RETURN_LEG_SETTLED = "This order has no parcel on its way back.";

/**
 * Take the parcel out of IN_TRANSIT, in one conditional write, and say whether
 * this call is the one that got it.
 *
 * The guard has to be part of the write rather than a read before it. Two
 * people with the same card open — or one person and a double-tapped button —
 * both pass a read-then-write check, and the loser writes a second full set of
 * write-off adjustments against a parcel that has already been booked in.
 * Nothing about that is visible afterwards except stock that is short.
 */
async function claimReturnLeg(
  tx: Prisma.TransactionClient,
  orderId: string,
  workspaceId: string,
  leg: "RECEIVED" | "LOST",
): Promise<boolean> {
  const claimed = await tx.order.updateMany({
    where: { id: orderId, workspaceId, status: "CANCELLED", returnLeg: "IN_TRANSIT" },
    data: { returnLeg: leg, returnLegAt: new Date() },
  });
  return claimed.count > 0;
}

/**
 * One line of a parcel that has come back: how many of it are fit to sell
 * again. `kind` says which list the id belongs to — a product-linked gift
 * travelled in the same box and comes back in it.
 */
const ReceivedLineSchema = z.object({
  kind: z.enum(["ITEM", "GIFT"]),
  id: z.string().min(1),
  good: z.coerce.number().int().nonnegative(),
});

const ReceiveSchema = z.object({
  lines: z.array(ReceivedLineSchema).min(1),
  /**
   * What happened to whatever didn't come back fit to sell. One answer for the
   * whole parcel rather than one per line: a parcel comes back soaked or comes
   * back light, and asking twelve times what happened to a box of hair clips
   * is how a form stops being filled in honestly.
   */
  shortfall: z.enum(["DAMAGED", "LOST"]).default("DAMAGED"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});
export type ReceiveReturnInput = z.input<typeof ReceiveSchema>;

/**
 * The parcel is back. Put the goods on the shelf and write off whatever
 * didn't survive the trip.
 *
 * The restoring is not done here — it happens by itself, because RECEIVED
 * takes the order out of `offShelfOrderWhere` and the derived stock rises by
 * the whole parcel. This only has to remove the part that came back broken or
 * short, which is why the two writes share a transaction: between them the
 * shelf would briefly claim pieces that are in the bin.
 */
export async function receiveReturnedGoods(
  slug: string,
  orderId: string,
  input: ReceiveReturnInput,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = ReceiveSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: { select: { id: true, productVariantId: true, quantity: true } },
      gifts: { select: { id: true, productVariantId: true, quantity: true } },
      customer: { select: { name: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
  // Checked here for a friendly refusal, and claimed again inside the
  // transaction where it actually binds — see claimReturnLeg.
  if (order.status !== "CANCELLED" || order.returnLeg !== "IN_TRANSIT") {
    return { ok: false, error: RETURN_LEG_SETTLED };
  }

  const shortfalls = returnShortfalls(order, d.lines);
  if (!shortfalls.ok) return shortfalls;

  const reason =
    (d.shortfall === "LOST" ? "Missing from a returned parcel" : "Damaged on the way back") +
    ` — order ${orderLabel(orderId, order.customer?.name)}` +
    (d.note?.trim() ? `: ${d.note.trim()}` : "");

  const settled = await prisma.$transaction(async (tx) => {
    if (!(await claimReturnLeg(tx, orderId, workspaceId, "RECEIVED"))) return false;
    if (shortfalls.rows.length > 0) {
      await tx.stockAdjustment.createMany({
        data: shortfalls.rows.map((r) => ({
          workspaceId,
          productVariantId: r.productVariantId,
          type: d.shortfall,
          delta: -r.quantity,
          reason,
          date: new Date(),
          dateHasTime: true,
        })),
      });
    }
    return true;
  });
  if (!settled) return { ok: false, error: RETURN_LEG_SETTLED };

  await refreshInventoryAlerts(workspaceId);

  const short = shortfalls.rows.reduce((s, r) => s + r.quantity, 0);
  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: orderLabel(orderId, order.customer?.name),
    summary:
      `Returned goods received — ${shortfalls.total - short} of ${shortfalls.total} pcs back on the shelf` +
      (short > 0 ? `, ${short} written off as ${d.shortfall.toLowerCase()}` : ""),
    changes: { returnLeg: { from: "IN_TRANSIT", to: "RECEIVED" } },
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * The parcel never came back.
 *
 * Written off rather than left pending forever, and written off as a real
 * adjustment rather than by holding the units out of stock: a courier that
 * loses a parcel costs the shop what the goods cost, and that belongs in the
 * stock-adjustment list with a date on it, where the shelf can be reconciled
 * against it. Holding them out silently would have left the shop looking for
 * pieces it had already lost.
 */
export async function writeOffReturnedGoods(
  slug: string,
  orderId: string,
  note?: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: { select: { id: true, productVariantId: true, quantity: true } },
      gifts: { select: { id: true, productVariantId: true, quantity: true } },
      customer: { select: { name: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (order.status !== "CANCELLED" || order.returnLeg !== "IN_TRANSIT") {
    return { ok: false, error: RETURN_LEG_SETTLED };
  }

  // Nothing came back, so every line's whole quantity is the shortfall.
  const all = returnShortfalls(order, [
    ...order.items.map((i) => ({ kind: "ITEM" as const, id: i.id, good: 0 })),
    ...order.gifts
      .filter((g) => g.productVariantId)
      .map((g) => ({ kind: "GIFT" as const, id: g.id, good: 0 })),
  ]);
  if (!all.ok) return all;

  const reason =
    `Never returned by the courier — order ${orderLabel(orderId, order.customer?.name)}` +
    (note?.trim() ? `: ${note.trim()}` : "");

  const settled = await prisma.$transaction(async (tx) => {
    if (!(await claimReturnLeg(tx, orderId, workspaceId, "LOST"))) return false;
    if (all.rows.length > 0) {
      await tx.stockAdjustment.createMany({
        data: all.rows.map((r) => ({
          workspaceId,
          productVariantId: r.productVariantId,
          type: "LOST" as const,
          delta: -r.quantity,
          reason,
          date: new Date(),
          dateHasTime: true,
        })),
      });
    }
    return true;
  });
  if (!settled) return { ok: false, error: RETURN_LEG_SETTLED };

  await refreshInventoryAlerts(workspaceId);

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: orderLabel(orderId, order.customer?.name),
    summary: `Returned parcel written off — ${all.total} pcs never came back`,
    changes: { returnLeg: { from: "IN_TRANSIT", to: "LOST" } },
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/dashboard`);
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

/**
 * Take another instalment: add what just came in to what was already paid.
 *
 * `amountPaid` is a running total, and updatePaymentStatus above sets it
 * outright. That is the wrong end to type at once a first instalment exists —
 * a customer paying 2,000 against a 3,500 balance means somebody has to work
 * out 3,500 and enter that, and getting the arithmetic wrong writes a due
 * figure nobody can trace back. Here the caller says what changed hands and
 * the total is worked out from what the order already holds, which is also the
 * only version that stays right when two people take money the same afternoon.
 *
 * Settling the balance exactly marks the order PAID rather than leaving it a
 * PARTIAL that happens to equal its total — PAID is what every downstream
 * reader checks, and `amountPaid` is deliberately ignored once it is set.
 */
export async function recordPayment(
  slug: string,
  orderId: string,
  amount: number,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };

  // A cancelled order sold nothing, so there is no balance to pay down — what
  // the customer handed over on a refused parcel is the cancellation's own
  // figure, and it is edited there.
  if (order.status === "CANCELLED") {
    return {
      ok: false,
      error:
        "This order is cancelled — there is no balance left to pay down. What the customer handed over at the door is edited on the order itself, under \"Collected on a partial delivery\".",
    };
  }

  const totals = computeOrderTotals(order);
  const total = totals.customerTotal;
  const applied = applyPayment(total, amountCollected(order, totals), amount);
  if (!applied.ok) return applied;

  const { collected, settled, remaining } = applied;
  // PAID means the whole customer total whatever this column says, so it is
  // cleared on the way through — the same thing updatePaymentStatus does.
  const paid = settled ? 0 : collected;
  const nextStatus: PaymentStatus = settled ? "PAID" : "PARTIAL";
  const received = round2(amount);

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: nextStatus, amountPaid: paid },
    });
    // More money collected means a bigger deposit, when this order's cash is
    // already banked. Only ever upwards from here, so none of the guards
    // updatePaymentStatus needs against shrinking a confirmed deposit apply.
    await syncOrderCashEntry(tx, workspaceId, orderId);
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: orderLabel(orderId, order.customer?.name),
    // The instalment, not just the new total: "৳2,000 received" is the fact
    // somebody will look for later, and the running total on its own hides it.
    summary: settled
      ? `৳${received} received — settled in full (৳${total})`
      : `৳${received} received — ৳${collected} of ৳${total} paid, ৳${remaining} still due`,
    changes: diffFields(
      { paymentStatus: order.paymentStatus, amountPaid: order.amountPaid },
      { paymentStatus: nextStatus, amountPaid: paid },
      ["paymentStatus", "amountPaid"],
    ),
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/customers`);
  revalidatePath(`/${slug}/dashboard`);
  revalidatePath(`/${slug}/treasury`);
  return { ok: true };
}

/**
 * Record that less money arrived than the customer paid.
 *
 * The case this exists for: a rider entered ৳900 into the courier's app
 * against a ৳960 invoice and kept the difference as a tip. The customer is
 * square, so nothing may be shown as owed by them; the courier will remit on
 * 900, so the balance and the treasury have to work from 900; and the 60 is a
 * loss, so profit has to carry it. One number, typed from the courier's own
 * screen, moves all four.
 *
 * The COD fee is re-quoted, not left alone. The courier charges its percentage
 * on what it actually collected — 1% of 900, not of 960 — and skipping that
 * leaves the reconciliation 60 paisa out, which is exactly the size of
 * unexplained gap that costs an evening to chase.
 */
export async function recordCollectedAmount(
  slug: string,
  orderId: string,
  /** What the courier's app says it collected. */
  collected: number,
  note: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: { items: { include: { returns: true } }, customer: { select: { name: true } } },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (order.status === "CANCELLED") {
    // A cancellation already has a field for what came back with the parcel,
    // and two ways to say the same thing is how they end up disagreeing.
    return {
      ok: false,
      error:
        'A cancelled order has no invoice to fall short of. Edit "Collected on a partial delivery" on the order instead.',
    };
  }

  const totals = computeOrderTotals(order);
  if (!Number.isFinite(collected) || collected < 0) {
    return { ok: false, error: "Enter what the courier actually collected" };
  }
  if (collected > totals.invoicedTotal) {
    // More than the invoice isn't a shortfall, and quietly storing a negative
    // one would credit the treasury with money nobody has.
    return {
      ok: false,
      error: `That's more than the order's ${totals.invoicedTotal}. Edit the order instead if the price changed.`,
    };
  }
  // Measured against the invoice rather than `customerTotal`, which has any
  // return taken off. The rider handed over what was on the label, so the gap
  // is against the label — and a return recorded later can't then leave a
  // shortfall stranded above what the order is now worth.
  const shortfall = round2(totals.invoicedTotal - collected);

  const quote = await quoteForOrder(workspaceId, {
    courierId: order.courierId ?? undefined,
    courierZoneId: order.courierZoneId ?? undefined,
    weightKg: order.weightKg == null ? undefined : Number(order.weightKg),
    // A typed cost stays typed: the person who read the courier's bill knows
    // better than the rate table, and re-quoting would silently overwrite it.
    deliveryCost: order.deliveryCost == null ? undefined : Number(order.deliveryCost),
    // Through the same helper as the other three, with the shortfall about to
    // be stored — which reproduces `collected` exactly, and keeps this path
    // from being a fourth private copy of the rule.
    codAmount: codCollectable(
      order.paymentMethod,
      codBaseFor({ ...order, collectionShortfall: shortfall }, totals),
    ),
  });

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        collectionShortfall: shortfall,
        collectionNote: note.trim() || null,
        codFeeCost: quote.codFeeCost,
      },
    });
    // The treasury may already hold a figure computed from the old amount.
    await syncOrderCashEntry(tx, workspaceId, orderId);
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: orderLabel(orderId, order.customer?.name),
    summary: shortfall
      ? `Courier collected ${collected} of ${totals.customerTotal} — ${shortfall} short${note.trim() ? ` (${note.trim()})` : ""}`
      : "Collection shortfall cleared — the full amount was collected",
    changes: diffFields(
      { collectionShortfall: order.collectionShortfall, codFeeCost: order.codFeeCost },
      { collectionShortfall: shortfall, codFeeCost: quote.codFeeCost },
      ["collectionShortfall", "codFeeCost"],
    ),
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
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
  /**
   * The customer has sent the goods and they haven't arrived yet.
   *
   * Off by default: most returns are written down with the box already open on
   * the counter, and that is the behaviour every return before this had. Ticked,
   * the refund and the invoice still move today — only the shelf waits.
   */
  goodsInTransit: checkboxField.default(false),
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
    goodsInTransit: formData.get("goodsInTransit"),
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
        // Null until the box is actually here — see Return.receivedAt.
        receivedAt: d.goodsInTransit ? null : new Date(),
      },
    });
    // A returned unit lowers what the customer owed, so the cash confirmed
    // into the treasury for this order is no longer all the business's. The
    // refund shows as the deposit shrinking rather than as its own line —
    // money that never reached the treasury can't leave it.
    await syncOrderCashEntry(tx, workspaceId, item.orderId);
  });

  // Returned goods go back on the shelf, which can clear a low-stock alert —
  // unless they're still in the post, and then nothing has moved yet.
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
      (d.refundAmount > 0 ? `, ৳${round2(d.refundAmount)} refunded` : ", no refund") +
      (d.goodsInTransit ? " — goods not here yet" : ""),
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * The returned goods have arrived. The only thing this moves is the shelf —
 * the refund and the invoice settled when the return was agreed.
 *
 * No condition question here, unlike a cancelled parcel's receive step: a
 * customer return is one line, and a piece that came back broken is a stock
 * adjustment the shop makes on its own terms rather than a number squeezed
 * into this dialog.
 */
export async function markReturnReceived(slug: string, returnId: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const row = await prisma.return.findFirst({
    where: { id: returnId, workspaceId },
    select: {
      id: true,
      quantity: true,
      receivedAt: true,
      orderItem: {
        select: {
          orderId: true,
          order: { select: { customer: { select: { name: true } } } },
          productVariant: {
            select: { attributes: true, product: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!row) return { ok: false, error: "Return not found" };
  // Already booked in — say so rather than re-stamping a date somebody may
  // have gone looking for. Conditional on receivedAt for the same reason the
  // parcel version is: a second click must not move a date it already set.
  const claimed = await prisma.return.updateMany({
    where: { id: returnId, workspaceId, receivedAt: null },
    data: { receivedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: "These goods are already booked in." };
  await refreshInventoryAlerts(workspaceId);

  const label = variantFullName(
    row.orderItem.productVariant.product.name,
    row.orderItem.productVariant.attributes,
  );
  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: row.orderItem.orderId,
    entityLabel: orderLabel(row.orderItem.orderId, row.orderItem.order.customer?.name),
    summary: `Returned goods received — ${row.quantity} × ${label} back on the shelf`,
  });

  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/products`);
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

/**
 * Bring parcel statuses up to date while somebody is looking at the list.
 *
 * The courier's webhook was meant to push these and doesn't, and the cron that
 * fetches them instead runs once a day — which is what a Hobby plan allows and
 * far too slow for a list somebody is making decisions on. So the page asks as
 * it opens, throttled to once every ten minutes per courier, exactly as the
 * call list pulls abandoned checkouts.
 *
 * Failure is swallowed on purpose: the list renders perfectly well from what is
 * already stored, and a courier being unreachable must not break the page it
 * was opened from.
 */
export async function refreshCourierStatuses(
  slug: string,
): Promise<{ ok: true; delivered: number } | { ok: false }> {
  const gate = await requireAccess(slug, "sales", "view");
  if (!gate.ok) return { ok: false };
  try {
    const res = await syncCourierStatuses({
      workspaceId: gate.access.workspaceId,
      max: 60,
      throttleMs: 10 * 60 * 1000,
    });
    if (res.changed > 0) {
      revalidatePath(`/${slug}/sales/orders`);
      revalidatePath(`/${slug}/couriers`);
      revalidatePath(`/${slug}/treasury`);
    }
    return { ok: true, delivered: res.delivered };
  } catch {
    return { ok: false };
  }
}
