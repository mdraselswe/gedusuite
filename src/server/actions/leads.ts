"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CallStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { createCustomer, findCustomerByPhone } from "@/server/actions/customers";
import { syncWooOrders, wooConfigured } from "@/lib/woo";
import { isOrderSource } from "@/lib/order-source";
import { nextOrderNo } from "@/lib/lead-order-no";
import { dhakaInputToDate } from "@/lib/dhaka-time";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Gated on `sales` rather than a module of its own, so rbac.ts stays untouched.
// STAFF has sales:add, which is deliberate — they're the ones making the calls.
const MODULE = "sales" as const;

const clean = (s?: string | null) => (s && s.trim() ? s.trim() : null);

/**
 * Every status means someone actually dialled, except NOT_CALLED and
 * DELIVERED — the latter is recorded after the parcel arrives, so counting it
 * as a call would inflate "called 3 times" for every completed order.
 */
function isCallOutcome(status: CallStatus) {
  return status !== CallStatus.NOT_CALLED && status !== CallStatus.DELIVERED;
}

const LeadSchema = z.object({
  customerName: z.string().trim().min(1, "Name is required").max(120),
  phone: z.string().trim().min(1, "Phone is required").max(40),
  altPhone: z.string().trim().max(40).optional().or(z.literal("")),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  itemsText: z.string().trim().max(1000).optional().or(z.literal("")),
  orderNo: z.string().trim().max(40).optional().or(z.literal("")),
  total: z.coerce.number().min(0).max(99_999_999).default(0),
  // Same vocabulary as an order's source, so a lead and the order it becomes
  // describe the channel the same way. Blank stays blank.
  channel: z.string().trim().optional().or(z.literal("")),
  // "2026-08-04T21:30" from a datetime-local input, read as Dhaka time.
  orderedAt: z.string().trim().optional().or(z.literal("")),
});

/** One reader for both create and update, so the two can't drift apart. */
function parseLead(formData: FormData) {
  return LeadSchema.safeParse({
    customerName: formData.get("customerName"),
    phone: formData.get("phone"),
    altPhone: formData.get("altPhone") ?? undefined,
    address: formData.get("address") ?? undefined,
    itemsText: formData.get("itemsText") ?? undefined,
    orderNo: formData.get("orderNo") ?? undefined,
    total: formData.get("total") ?? 0,
    channel: formData.get("channel") ?? undefined,
    orderedAt: formData.get("orderedAt") ?? undefined,
  });
}

/**
 * The serial to offer for the next manual entry — "#0001", "#0002", …
 *
 * Asked for when the add form opens rather than worked out on the page: the
 * list is paginated, so the rows the browser holds are only the newest 50 and
 * the highest number in use may not be among them.
 *
 * Website rows are excluded; they carry WooCommerce's own numbering, which
 * would drag the manual serial up to wherever the store happens to be.
 */
export async function nextManualOrderNo(
  slug: string,
): Promise<{ ok: true; orderNo: string } | { ok: false; error: string }> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  const rows = await prisma.orderLead.findMany({
    where: { workspaceId: gate.access.workspaceId, source: "MANUAL", orderNo: { not: null } },
    select: { orderNo: true },
  });

  return { ok: true, orderNo: nextOrderNo(rows.map((r) => r.orderNo)) };
}

/** Manual entry, so the list is usable before the WooCommerce webhook exists. */
export async function createLead(slug: string, formData: FormData): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  const parsed = parseLead(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  await prisma.orderLead.create({
    data: {
      workspaceId: gate.access.workspaceId,
      source: "MANUAL",
      // The unique key is (workspace, source, externalId); manual rows have no
      // upstream id, so mint one rather than leaving it blank and colliding.
      externalId: randomUUID(),
      orderNo: clean(d.orderNo),
      customerName: d.customerName,
      phone: d.phone,
      altPhone: clean(d.altPhone),
      address: clean(d.address),
      itemsText: d.itemsText?.trim() ?? "",
      total: d.total,
      channel: isOrderSource(d.channel) ? d.channel : null,
      // An order taken on the phone is often written up later, so when it was
      // placed is a real answer — but an unparseable one falls through to the
      // column default rather than being stored wrong.
      ...(dhakaInputToDate(d.orderedAt) ? { orderedAt: dhakaInputToDate(d.orderedAt)! } : {}),
    },
  });

  revalidatePath(`/${slug}/leads`);
  return { ok: true };
}

/**
 * Correct a lead's own details. Call tracking — status, attempts, who called,
 * the notes — is untouched: editing what was ordered is not a call, and
 * resetting that history because a phone number had a typo would lose the
 * only record of the chasing already done.
 *
 * Website leads are editable too, but the WooCommerce sync writes its fields
 * back on every pull, so a correction to one of those is temporary. Anything
 * genuinely wrong should be fixed in WooCommerce.
 */
export async function updateLead(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  const parsed = parseLead(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const orderedAt = dhakaInputToDate(d.orderedAt);

  const res = await prisma.orderLead.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: {
      orderNo: clean(d.orderNo),
      customerName: d.customerName,
      phone: d.phone,
      altPhone: clean(d.altPhone),
      address: clean(d.address),
      itemsText: d.itemsText?.trim() ?? "",
      total: d.total,
      channel: isOrderSource(d.channel) ? d.channel : null,
      // Left alone when the field comes back unparseable, rather than
      // overwriting a good timestamp with a guess.
      ...(orderedAt ? { orderedAt } : {}),
    },
  });
  if (res.count === 0) return { ok: false, error: "Lead not found" };

  revalidatePath(`/${slug}/leads`);
  return { ok: true };
}

/**
 * Record the outcome of a call. Bumps the attempt counter and stamps who
 * called, so "called 3 times, last by Rasel" is answerable later.
 */
export async function setLeadStatus(
  slug: string,
  id: string,
  status: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  if (!Object.values(CallStatus).includes(status as CallStatus)) {
    return { ok: false, error: "Unknown call status" };
  }
  const next = status as CallStatus;
  const user = await requireUser();

  const res = await prisma.orderLead.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: isCallOutcome(next)
      ? {
          callStatus: next,
          callAttempts: { increment: 1 },
          lastCalledAt: new Date(),
          calledByName: user.name ?? user.email ?? null,
        }
      : { callStatus: next },
  });
  if (res.count === 0) return { ok: false, error: "Lead not found" };

  revalidatePath(`/${slug}/leads`);
  return { ok: true };
}

/**
 * Tag which channel a lead came through, from the list rather than a form —
 * the ones already in the table predate the field and would otherwise stay
 * blank forever.
 */
export async function setLeadChannel(
  slug: string,
  id: string,
  channel: string | null,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  if (channel !== null && !isOrderSource(channel)) {
    return { ok: false, error: "Unknown channel" };
  }

  const res = await prisma.orderLead.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: { channel },
  });
  if (res.count === 0) return { ok: false, error: "Lead not found" };

  revalidatePath(`/${slug}/leads`);
  return { ok: true };
}

/** Free-text fields — editing these is not a call, so no attempt bump. */
export async function updateLeadNotes(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  const parsed = z
    .object({
      customerAdvice: z.string().trim().max(1000).optional().or(z.literal("")),
      internalNote: z.string().trim().max(1000).optional().or(z.literal("")),
    })
    .safeParse({
      customerAdvice: formData.get("customerAdvice") ?? undefined,
      internalNote: formData.get("internalNote") ?? undefined,
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const res = await prisma.orderLead.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: {
      customerAdvice: clean(parsed.data.customerAdvice),
      internalNote: clean(parsed.data.internalNote),
    },
  });
  if (res.count === 0) return { ok: false, error: "Lead not found" };

  revalidatePath(`/${slug}/leads`);
  return { ok: true };
}

/**
 * Shortcut for the order form: turn a lead's contact details into a real
 * Customer, so the sales page's existing customer search finds them and no
 * retyping is needed. Reuses createCustomer verbatim — its own RBAC check
 * (customers:add) and validation apply, and nothing here duplicates that logic.
 * The sales page itself is untouched.
 */
export async function createCustomerFromLead(
  slug: string,
  id: string,
): Promise<ActionResult & { customerId?: string; customerName?: string; matched?: boolean }> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;

  const lead = await prisma.orderLead.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.convertedCustomerId) {
    return { ok: false, error: "A customer was already created from this order" };
  }

  // A repeat buyer would otherwise become a second customer row, splitting
  // their order history and outstanding balance in half — and hiding how often
  // this number has cancelled before, which is the thing worth knowing before
  // sending a COD parcel. Link to the existing record instead.
  const existing = await findCustomerByPhone(slug, lead.phone);
  if (existing) {
    await prisma.orderLead.updateMany({
      where: { id, workspaceId: gate.access.workspaceId },
      data: { convertedCustomerId: existing.id },
    });
    revalidatePath(`/${slug}/leads`);
    return { ok: true, customerId: existing.id, customerName: existing.name, matched: true };
  }

  const fd = new FormData();
  fd.set("name", lead.customerName);
  fd.set("phone", lead.phone);
  if (lead.altPhone) fd.set("altPhone", lead.altPhone);
  if (lead.address) fd.set("address", lead.address);
  fd.set("notes", `From online order${lead.orderNo ? ` ${lead.orderNo}` : ""}`);

  const created = await createCustomer(slug, fd);
  if (!created.ok) return created;

  await prisma.orderLead.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: { convertedCustomerId: created.id ?? null },
  });

  revalidatePath(`/${slug}/leads`);
  return { ok: true, customerId: created.id, customerName: created.name };
}

/** How long a pull is considered fresh enough to skip repeating. */
const SYNC_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Pull orders from WooCommerce into the call list.
 *
 * The webhook already delivers real orders, but WooCommerce fires nothing for
 * a checkout-draft — a customer who filled in the checkout and never pressed
 * Place order. Those only ever appear by asking, which is what this does.
 *
 * Called on its own from the page (throttled, so opening the list repeatedly
 * doesn't hammer the store) and by the Refresh button (force). Failure is
 * reported, never thrown: the list still renders fine from what's already in
 * the database, and the website being unreachable must not break the page.
 */
export async function syncFromWebsite(
  slug: string,
  force = false,
): Promise<ActionResult & { imported?: number; skipped?: boolean }> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;
  if (!wooConfigured()) return { ok: false, error: "Website connection is not configured" };

  const workspaceId = gate.access.workspaceId;

  if (!force) {
    const state = await prisma.wooSyncState.findUnique({ where: { workspaceId } });
    if (state && Date.now() - state.lastSyncAt.getTime() < SYNC_THROTTLE_MS) {
      return { ok: true, skipped: true };
    }
  }

  try {
    const res = await syncWooOrders(workspaceId);
    await prisma.wooSyncState.upsert({
      where: { workspaceId },
      create: { workspaceId, lastSyncAt: new Date(), lastResult: `${res.upserted} orders` },
      update: { lastSyncAt: new Date(), lastResult: `${res.upserted} orders` },
    });
    revalidatePath(`/${slug}/leads`);
    return { ok: true, imported: res.upserted };
  } catch (e) {
    // Stamp the attempt anyway, so a website that's down doesn't turn every
    // page view into another slow, failing round trip.
    await prisma.wooSyncState.upsert({
      where: { workspaceId },
      create: { workspaceId, lastSyncAt: new Date(), lastResult: `failed: ${String(e)}` },
      update: { lastSyncAt: new Date(), lastResult: `failed: ${String(e)}` },
    });
    return { ok: false, error: "Couldn't reach the website just now" };
  }
}

export async function deleteLead(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;

  const res = await prisma.orderLead.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  if (res.count === 0) return { ok: false, error: "Lead not found" };

  revalidatePath(`/${slug}/leads`);
  return { ok: true };
}
