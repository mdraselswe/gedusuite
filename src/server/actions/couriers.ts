"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { failed, type ActionFailure } from "@/lib/form";
import { diffFields, recordActivity } from "@/lib/activity";
import { getBalance } from "@/lib/steadfast";
import {
  encryptCredentials,
  newWebhookToken,
  webhookUrlFor,
} from "@/lib/courier-credentials";

export type ActionResult = { ok: true; id?: string } | ActionFailure;

// Couriers are sales plumbing rather than a module of their own, so they ride
// on the `sales` permission and rbac.ts needs no new entry.
const MODULE = "sales" as const;

const ZoneSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Every zone needs a name").max(60),
  rate: z.coerce.number().nonnegative().max(99_999),
});

const CourierSchema = z.object({
  name: z.string().trim().min(1, "Courier name is required").max(80),
  baseWeightKg: z.coerce.number().positive().max(1000).default(1),
  extraKgRate: z.coerce.number().nonnegative().max(99_999).default(0),
  // Percent, not a fraction: 1 means 1%. Capped below 100 because a fee that
  // eats the whole collection has no break-even and nothing else would work.
  codFeePercent: z.coerce.number().min(0).max(99).default(0),
  codFeeBase: z.enum(["GROSS", "NET"]).default("NET"),
  returnChargeType: z.enum(["NONE", "FLAT", "PERCENT_OF_DELIVERY"]).default("NONE"),
  returnChargeValue: z.coerce.number().nonnegative().max(99_999).default(0),
  isDefault: z.coerce.boolean().default(false),
  isActive: z.coerce.boolean().default(true),
  notes: z.string().trim().max(300).optional().or(z.literal("")),
  zones: z.array(ZoneSchema).min(1, "Add at least one zone"),
});

export type CourierInput = z.input<typeof CourierSchema>;

/** Only one default per workspace — the order form has to pick exactly one. */
async function clearOtherDefaults(workspaceId: string, keepId?: string) {
  await prisma.courier.updateMany({
    where: { workspaceId, isDefault: true, ...(keepId ? { id: { not: keepId } } : {}) },
    data: { isDefault: false },
  });
}

export async function createCourier(slug: string, input: CourierInput): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = CourierSchema.safeParse(input);
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  const courier = await prisma.courier.create({
    data: {
      workspaceId,
      name: d.name,
      isDefault: d.isDefault,
      isActive: d.isActive,
      baseWeightKg: d.baseWeightKg,
      extraKgRate: d.extraKgRate,
      codFeePercent: d.codFeePercent,
      codFeeBase: d.codFeeBase,
      returnChargeType: d.returnChargeType,
      returnChargeValue: d.returnChargeValue,
      notes: d.notes?.trim() || null,
      zones: {
        create: d.zones.map((z, i) => ({ workspaceId, name: z.name, rate: z.rate, sortOrder: i })),
      },
    },
  });
  if (d.isDefault) await clearOtherDefaults(workspaceId, courier.id);

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "Courier",
    entityId: courier.id,
    entityLabel: d.name,
    summary: `Added — ${d.codFeePercent}% COD fee on ${d.codFeeBase}, ${d.zones.length} zone(s)`,
  });

  revalidateCouriers(slug);
  return { ok: true, id: courier.id };
}

export async function updateCourier(
  slug: string,
  id: string,
  input: CourierInput,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.courier.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      zones: { select: { id: true, name: true, rate: true } },
      name: true,
      isDefault: true,
      isActive: true,
      baseWeightKg: true,
      extraKgRate: true,
      codFeePercent: true,
      codFeeBase: true,
      returnChargeType: true,
      returnChargeValue: true,
    },
  });
  if (!existing) return { ok: false, error: "Courier not found" };

  const parsed = CourierSchema.safeParse(input);
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  // Zones are matched by id and updated in place rather than deleted and
  // recreated: orders point at a zone, and replacing the rows would strip
  // every past order of the rate it was actually quoted.
  const keptIds = d.zones.map((z) => z.id).filter((z): z is string => !!z);
  const removed = existing.zones.filter((z) => !keptIds.includes(z.id)).map((z) => z.id);

  await prisma.$transaction(async (tx) => {
    await tx.courier.update({
      where: { id },
      data: {
        name: d.name,
        isDefault: d.isDefault,
        isActive: d.isActive,
        baseWeightKg: d.baseWeightKg,
        extraKgRate: d.extraKgRate,
        codFeePercent: d.codFeePercent,
        codFeeBase: d.codFeeBase,
        returnChargeType: d.returnChargeType,
        returnChargeValue: d.returnChargeValue,
        notes: d.notes?.trim() || null,
      },
    });
    for (const [i, z] of d.zones.entries()) {
      if (z.id) {
        await tx.courierZone.updateMany({
          where: { id: z.id, courierId: id },
          data: { name: z.name, rate: z.rate, sortOrder: i },
        });
      } else {
        await tx.courierZone.create({
          data: { workspaceId, courierId: id, name: z.name, rate: z.rate, sortOrder: i },
        });
      }
    }
    // A zone still used by an order can't be deleted — the FK is SET NULL, so
    // deleting would quietly detach history. Deactivate the courier instead.
    if (removed.length) {
      const inUse = await tx.order.count({ where: { courierZoneId: { in: removed } } });
      if (inUse === 0) {
        await tx.courierZone.deleteMany({ where: { id: { in: removed }, courierId: id } });
      }
    }
  });
  if (d.isDefault) await clearOtherDefaults(workspaceId, id);

  // A courier's rules decide every future parcel's cost and every COD fee, so
  // a quiet edit here moves profit on orders nobody has placed yet. Zone rates
  // are folded into the same entry rather than one line per zone — the whole
  // table is what somebody changed.
  const courierChanges = diffFields(existing, d, ["name", "isDefault", "isActive", "baseWeightKg", "extraKgRate", "codFeePercent", "codFeeBase", "returnChargeType", "returnChargeValue"]);
  const zoneMoves = d.zones
    .filter((z) => {
      const was = existing.zones.find((e) => e.id === z.id);
      return was && (was.name !== z.name || Number(was.rate) !== z.rate);
    })
    .map((z) => {
      const was = existing.zones.find((e) => e.id === z.id)!;
      return `${was.name} ৳${Number(was.rate)} → ${z.name} ৳${z.rate}`;
    });
  if (courierChanges || zoneMoves.length > 0) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Courier",
      entityId: id,
      entityLabel: d.name,
      summary:
        zoneMoves.length > 0
          ? `Rules edited — zones: ${zoneMoves.join(", ")}`
          : "Rules edited",
      changes: courierChanges,
    });
  }

  revalidateCouriers(slug);
  return { ok: true };
}

export async function deleteCourier(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const courier = await prisma.courier.findFirst({
    where: { id, workspaceId },
    select: { id: true, name: true },
  });
  if (!courier) return { ok: false, error: "Courier not found" };

  const used = await prisma.order.count({ where: { courierId: id, workspaceId } });
  if (used > 0) {
    return {
      ok: false,
      error: `${used} order(s) were sent with this courier. Turn it off instead of deleting, so their costs stay explainable.`,
    };
  }

  await prisma.courier.delete({ where: { id } });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "Courier",
    entityId: id,
    entityLabel: courier.name,
    summary: "Deleted — no order had used it",
  });

  revalidateCouriers(slug);
  return { ok: true };
}

const ApiCredentialsSchema = z.object({
  apiKey: z.string().trim().min(8, "That does not look like an API key").max(200),
  secretKey: z.string().trim().min(8, "That does not look like a secret key").max(200),
});

/**
 * Store a courier's API credentials so parcels can be booked from here.
 *
 * The key is verified against the courier before it is saved — `get_balance`
 * is the cheapest call that proves both halves work. Saving an unchecked key
 * only moves the failure to the first person trying to book a real parcel,
 * with a parcel already packed and a customer already waiting.
 *
 * Nothing about the key reaches the activity log. "Connected" is the event
 * worth recording; the credential is not.
 */
export async function connectCourierApi(
  slug: string,
  courierId: string,
  input: { apiKey: string; secretKey: string },
): Promise<ActionResult & { webhookUrl?: string }> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = ApiCredentialsSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error);

  const courier = await prisma.courier.findFirst({
    where: { id: courierId, workspaceId },
    select: { id: true, name: true, webhookToken: true },
  });
  if (!courier) return { ok: false, error: "Courier not found" };

  const check = await getBalance(parsed.data);
  if (!check.ok) return { ok: false, error: check.error };

  const token = courier.webhookToken ?? newWebhookToken();
  await prisma.courier.update({
    where: { id: courier.id },
    data: {
      apiProvider: "STEADFAST",
      ...encryptCredentials(parsed.data),
      webhookToken: token,
    },
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Courier",
    entityId: courier.id,
    entityLabel: courier.name,
    summary: "API connected — parcels can now be booked from GeduSuite",
  });

  revalidateCouriers(slug);
  return { ok: true, webhookUrl: webhookUrlFor(token) ?? undefined };
}

/**
 * Forget the stored credentials. The webhook token stays: the courier may
 * still post an update about a parcel booked before this, and a 404 on its
 * side is a worse answer than recording it.
 */
export async function disconnectCourierApi(
  slug: string,
  courierId: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;

  const courier = await prisma.courier.findFirst({
    where: { id: courierId, workspaceId: gate.access.workspaceId },
    select: { id: true, name: true },
  });
  if (!courier) return { ok: false, error: "Courier not found" };

  await prisma.courier.update({
    where: { id: courier.id },
    data: { apiKeyEnc: null, apiSecretEnc: null, apiProvider: null },
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Courier",
    entityId: courier.id,
    entityLabel: courier.name,
    summary: "API disconnected — parcels go back to being booked by hand",
  });

  revalidateCouriers(slug);
  return { ok: true };
}

function revalidateCouriers(slug: string) {
  revalidatePath(`/${slug}/settings/couriers`);
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
}

/**
 * Steadfast's rules as this shop actually pays them — offered as a starting
 * point so the first courier is one click rather than eight fields, and
 * because these numbers were worked out the hard way, from a statement.
 */
export async function createSteadfastPreset(slug: string): Promise<ActionResult> {
  return createCourier(slug, {
    name: "Steadfast",
    baseWeightKg: 1,
    extraKgRate: 20,
    codFeePercent: 1,
    // Verified against a real balance: 1% is taken on what's handed over,
    // not on the whole COD.
    codFeeBase: "NET",
    returnChargeType: "NONE",
    returnChargeValue: 0,
    isDefault: true,
    isActive: true,
    notes: "Rates as negotiated — the public calculator quotes less.",
    zones: [
      { name: "Dhaka City", rate: 65 },
      { name: "Outside Dhaka", rate: 115 },
    ],
  });
}
