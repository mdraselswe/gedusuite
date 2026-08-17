"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { failed, type ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { updateOrderStatus } from "@/server/actions/orders";
import { computeOrderTotals } from "@/lib/orders";
import { amountOutstanding, codCollectable } from "@/lib/order-cash";
import { variantFullName } from "@/lib/variants";
import { detectDistrict } from "@/lib/bd-locations";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import {
  buildInvoice,
  buildItemDescription,
  createParcel,
  normalizePhone,
} from "@/lib/steadfast";

export type ActionResult = { ok: true; id?: string; warning?: string } | ActionFailure;

const MODULE = "sales" as const;

/**
 * Booking a consignment makes an order PACKED, not SHIPPED.
 *
 * The consignment is paperwork. Nothing has been handed to a rider yet — the
 * parcel is on the table with a label on it, waiting for a pickup that happens
 * later that day or the next. That is what PACKED already means here: "picked,
 * packed and waiting for the courier". Steadfast agrees, and says so: a fresh
 * consignment comes back `in_review`, not in transit.
 *
 * SHIPPED stays a manual step, pressed when the parcel actually leaves. An
 * order that says SHIPPED while it is still in the shop is a lie the courier
 * reconciliation has no way to catch.
 *
 * Only these two advance. PACKED is already right; SHIPPED and DELIVERED are
 * further on and must not be walked backwards by a re-booking; CANCELLED never
 * gets this far.
 */
const ADVANCES_ON_BOOKING: readonly string[] = ["PENDING", "CONFIRMED"];
const STATUS_AFTER_BOOKING = "PACKED";

/**
 * Booking an order's parcel with the courier, instead of retyping it into the
 * courier's app.
 *
 * Two things this deliberately does not do.
 *
 * It does not book anything on its own. A parcel is money and a customer's
 * address leaving the building, and the one thing worse than typing it twice
 * is sending it somewhere nobody looked at. Every booking is a person pressing
 * a button on a dialog that shows them exactly what will be sent.
 *
 * It does not assemble the address. Steadfast's API has no district or city
 * field — see lib/steadfast — so `recipient_address` is one line of free text
 * and whatever is in it is the whole of what the courier's sorters get. An
 * earlier draft put district and thana pickers on the dialog and appended what
 * was chosen; that was scaffolding around a field the person is already
 * reading, so the field itself is now editable and the pickers are gone. What
 * is in the box is what is sent, and it is also written back to the order,
 * because shipAddress means "where this parcel was actually sent".
 */

/** What the confirm dialog shows, and what it needs to show it. */
export type ParcelPreview = {
  orderNo: number | null;
  invoice: string;
  recipientName: string;
  /** Normalised, or null when the stored number is not a BD mobile. */
  recipientPhone: string | null;
  rawPhone: string;
  /** Pre-fills the editable address box — the order's address, untouched. */
  address: string;
  codAmount: number;
  itemDescription: string;
  /**
   * Pre-fills the note box from the order's own note — shown, so it can be
   * edited or cleared. Never sent behind the dialog's back: an order note is
   * written for the shop ("refused a parcel last time", "partner's order"),
   * and the courier prints what it is given onto a label the customer holds.
   */
  note: string;
  courierName: string | null;
  /**
   * The zone this parcel is priced on, so the dialog can question it. The
   * address is free text and the zone is a dropdown, and nothing has ever
   * compared the two — a Keraniganj parcel went out on the Dhaka City rate at
   * 65 against the 105 it was billed, and turned up two days later inside an
   * unexplained gap.
   */
  zoneName: string | null;
  /** Everything below is a reason the Send button stays disabled. */
  blockers: string[];
};

/**
 * Everything the dialog needs, gathered before anything is sent.
 *
 * The blockers are computed here rather than in the client so that the reason
 * a parcel cannot go is the same one the server would give — the dialog can't
 * offer a button the action would refuse.
 */
export async function parcelPreview(
  slug: string,
  orderId: string,
): Promise<{ ok: true; preview: ParcelPreview } | ActionFailure> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: {
        include: {
          returns: true,
          productVariant: { select: { attributes: true, product: { select: { name: true } } } },
        },
      },
      customer: { select: { id: true, name: true, phone: true, address: true } },
      courier: { select: { id: true, name: true, apiProvider: true, apiKeyEnc: true } },
      courierZone: { select: { name: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };

  const totals = computeOrderTotals(order);
  const name = order.shipName ?? order.customer?.name ?? "";
  const rawPhone = order.shipPhone ?? order.customer?.phone ?? "";
  const street = order.shipAddress ?? order.customer?.address ?? "";

  const blockers: string[] = [];
  if (order.deliveryType !== "COURIER") {
    blockers.push("This order is marked for self-delivery, not a courier");
  }
  if (order.status === "CANCELLED") blockers.push("This order is cancelled");
  if (order.courierTrackingId) {
    blockers.push(`Already booked — consignment ${order.courierTrackingId}`);
  }
  if (!order.courier) blockers.push("No courier is set on this order");
  else if (!order.courier.apiKeyEnc) {
    blockers.push(`${order.courier.name} has no API key — add one in Settings → Couriers`);
  }
  if (!name.trim()) blockers.push("No recipient name");
  if (!street.trim()) blockers.push("No delivery address");
  if (!normalizePhone(rawPhone)) {
    blockers.push(
      rawPhone.trim()
        ? `"${rawPhone}" is not a Bangladeshi mobile number`
        : "No phone number to deliver to",
    );
  }

  return {
    ok: true,
    preview: {
      orderNo: order.orderNo,
      // Null orderNo only survives on a row older than the backfill. Showing
      // "GEDUSHOP-0" would be a number the booking then contradicts, so say
      // that it is coming instead.
      invoice: order.orderNo == null ? "— assigned on booking —" : buildInvoice(slug, order.orderNo),
      recipientName: name.trim(),
      recipientPhone: normalizePhone(rawPhone),
      rawPhone: rawPhone.trim(),
      address: street.trim(),
      codAmount: codCollectable(order.paymentMethod, amountOutstanding(order, totals)),
      itemDescription: buildItemDescription(
        order.items.map((i) => ({
          name: variantFullName(i.productVariant.product.name, i.productVariant.attributes),
          quantity: i.quantity,
        })),
      ),
      note: (order.notes ?? "").trim().slice(0, 300),
      courierName: order.courier?.name ?? null,
      zoneName: order.courierZone?.name ?? null,
      blockers,
    },
  };
}

const BookSchema = z.object({
  // The whole address, as it stands in the dialog's box. 15 characters is not
  // a judgement about address quality — it only catches a box left empty or
  // half-typed, which is the one failure a person cannot see themselves make.
  address: z
    .string()
    .trim()
    .min(15, "That address is too short to deliver to")
    .max(500),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

export type BookParcelInput = z.input<typeof BookSchema>;

export async function bookParcel(
  slug: string,
  orderId: string,
  input: BookParcelInput,
): Promise<ActionResult & { consignmentId?: string; trackingCode?: string }> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = BookSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: {
        include: {
          returns: true,
          productVariant: { select: { attributes: true, product: { select: { name: true } } } },
        },
      },
      customer: { select: { name: true, phone: true, address: true } },
      courier: { select: { id: true, name: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };

  // Re-checked here and not merely in the dialog: a preview can be minutes old,
  // and the one failure that must never happen is the same parcel going twice.
  if (order.courierTrackingId) {
    return {
      ok: false,
      error: `Already booked — consignment ${order.courierTrackingId}. Cancel it in the Steadfast app before booking again.`,
    };
  }
  if (order.deliveryType !== "COURIER") {
    return { ok: false, error: "This order is marked for self-delivery" };
  }
  if (order.status === "CANCELLED") {
    return { ok: false, error: "This order is cancelled" };
  }
  if (!order.courier) return { ok: false, error: "No courier is set on this order" };

  const creds = await loadCourierCredentials(order.courier.id);
  if (!creds) {
    return {
      ok: false,
      error: `${order.courier.name} has no working API key — add one in Settings → Couriers`,
    };
  }

  const name = (order.shipName ?? order.customer?.name ?? "").trim();
  const phone = normalizePhone(order.shipPhone ?? order.customer?.phone);
  if (!name) return { ok: false, error: "No recipient name" };
  if (!phone) return { ok: false, error: "No valid Bangladeshi mobile number for this order" };

  // What the courier is told to collect, by the same rule the rest of the app
  // prices with: only a COURIER_COLLECTION order has anything to hand over.
  // Using the outstanding amount alone would put the full invoice on a parcel
  // the customer already paid for by bKash — collected twice, and against a
  // COD fee that was quoted at zero.
  const totals = computeOrderTotals(order);
  const cod = codCollectable(order.paymentMethod, amountOutstanding(order, totals));

  // orderNo is backfilled and always assigned on create; the fallback is for a
  // row that somehow predates both, and keeps the invoice unique either way.
  const orderNo = order.orderNo ?? (await assignOrderNo(workspaceId, order.id));

  // Claim the order before a single byte goes to the courier. The check above
  // is a courtesy that gives a good error message; THIS is what stops two
  // clicks becoming two parcels, because only one conditional update can win.
  const claim = await prisma.order.updateMany({
    where: {
      id: order.id,
      workspaceId,
      courierTrackingId: null,
      OR: [{ courierBookingAt: null }, { courierBookingAt: { lt: staleClaimCutoff() } }],
    },
    data: { courierBookingAt: new Date() },
  });
  if (claim.count === 0) {
    return {
      ok: false,
      error:
        "This order is already being booked — wait a moment and refresh before trying again.",
    };
  }

  const result = await createParcel(creds, {
    invoice: buildInvoice(slug, orderNo),
    recipient_name: name,
    recipient_phone: phone,
    // Exactly what was in the box on the dialog. Nothing appended, nothing
    // reformatted — whoever pressed Book read this line.
    recipient_address: d.address,
    cod_amount: cod,
    // What is in the dialog's note box, and nothing else. The order's own note
    // pre-fills that box (see parcelPreview) so it can be read and edited
    // first — falling back to it silently would print internal remarks on the
    // label the customer takes delivery with.
    note: d.note || undefined,
    item_description: buildItemDescription(
      order.items.map((i) => ({
        name: variantFullName(i.productVariant.product.name, i.productVariant.attributes),
        quantity: i.quantity,
      })),
    ),
  });

  if (!result.ok) {
    // Nothing was booked, so hand the order back rather than making whoever
    // fixes the address wait two minutes for the claim to go stale.
    await prisma.order.update({
      where: { id: order.id },
      data: { courierBookingAt: null },
    });
    return { ok: false, error: result.error };
  }

  const consignment = result.data;
  try {
    await prisma.order.update({
    where: { id: order.id },
    data: {
      orderNo,
      courierBookingAt: null,
      courierTrackingId: String(consignment.consignment_id),
      courierTrackingCode: consignment.tracking_code ?? null,
      courierStatus: consignment.status ?? "in_review",
      courierStatusAt: new Date(),
      // What actually went on the parcel, which is what this column means. If
      // the address was corrected in the dialog, the order now says the same
      // thing the courier was told — otherwise the invoice and the label
      // disagree and neither one is obviously the wrong one.
      shipAddress: d.address,
      // A tag for reports, never for a delivery decision. Null is a normal
      // answer here — plenty of good addresses name no district we can match.
      shipDistrict: detectDistrict(d.address),
    },
    });
  } catch (e) {
    // The parcel exists at the courier and this app failed to write it down —
    // the one state nobody can recover from a screen that says "failed". Put
    // the consignment number in front of the operator so it can be typed into
    // the Courier ID field by hand, and say plainly not to press Book again.
    console.error("[steadfast] booked but not recorded", {
      orderId: order.id,
      consignmentId: consignment.consignment_id,
      error: e,
    });
    return {
      ok: false,
      error: `Parcel WAS booked — consignment ${consignment.consignment_id}, tracking ${consignment.tracking_code} — but saving it here failed. Type that consignment number into Courier ID. Do NOT book again.`,
    };
  }

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: order.id,
    entityLabel: order.customer?.name ?? `Order ${orderNo}`,
    summary: `Booked with ${order.courier.name} — consignment ${consignment.consignment_id}, COD ${cod.toFixed(2)}`,
  });

  // The parcel now has a label and is waiting for a pickup, which is PACKED.
  // Routed through updateOrderStatus rather than written here: moving into a
  // stock-consuming status consumes stock and re-quotes the courier's COD fee,
  // and a second copy of that arithmetic is a second answer waiting to
  // disagree with the first.
  //
  // A failure here does not fail the booking. The parcel genuinely exists, and
  // reporting that as an error would leave the operator believing it does not
  // and pressing the button again. It comes back as a warning with the reason
  // — "Not enough stock to confirm this order" is the likely one, and it is
  // worth reading rather than swallowing.
  let warning: string | undefined;
  if (ADVANCES_ON_BOOKING.includes(order.status)) {
    const moved = await updateOrderStatus(slug, order.id, STATUS_AFTER_BOOKING);
    if (!moved.ok) {
      warning = `Booked, but the order is still ${order.status} — ${moved.error}`;
    }
  }

  revalidateOrder(slug, order.id);
  return {
    ok: true,
    warning,
    consignmentId: String(consignment.consignment_id),
    trackingCode: consignment.tracking_code,
  };
}

/**
 * How old a booking claim has to be before another request may take it. Two
 * minutes is comfortably past the client's own 20-second timeout, so a claim
 * this stale belongs to a request that is not coming back.
 */
function staleClaimCutoff(): Date {
  return new Date(Date.now() - 2 * 60 * 1000);
}

/** Last-resort number for a row that has none. Rare enough not to need a lock. */
async function assignOrderNo(workspaceId: string, orderId: string): Promise<number> {
  const highest = await prisma.order.aggregate({
    where: { workspaceId },
    _max: { orderNo: true },
  });
  const next = (highest._max.orderNo ?? 0) + 1;
  await prisma.order.update({ where: { id: orderId }, data: { orderNo: next } });
  return next;
}

function revalidateOrder(slug: string, orderId: string) {
  revalidatePath(`/${slug}/sales/orders`);
  // The invoice prints the courier's consignment number, so it goes stale the
  // moment one is booked. There is no /sales/orders/[id] page to revalidate —
  // the id-scoped routes are these two.
  revalidatePath(`/${slug}/sales/orders/${orderId}/invoice`);
  revalidatePath(`/${slug}/sales/orders/${orderId}/breakdown`);
  revalidatePath(`/${slug}/couriers`);
}
