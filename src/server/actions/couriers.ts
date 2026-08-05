"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

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
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
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
    select: { id: true, zones: { select: { id: true } } },
  });
  if (!existing) return { ok: false, error: "Courier not found" };

  const parsed = CourierSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
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

  revalidateCouriers(slug);
  return { ok: true };
}

export async function deleteCourier(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const courier = await prisma.courier.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!courier) return { ok: false, error: "Courier not found" };

  const used = await prisma.order.count({ where: { courierId: id, workspaceId } });
  if (used > 0) {
    return {
      ok: false,
      error: `${used} order(s) were sent with this courier. Turn it off instead of deleting, so their costs stay explainable.`,
    };
  }

  await prisma.courier.delete({ where: { id } });
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
