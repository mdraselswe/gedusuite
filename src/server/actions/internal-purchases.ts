"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

const CATEGORIES = [
  "OFFICE_SUPPLIES",
  "PACKAGING_MATERIAL",
  "EQUIPMENT",
  "UTILITIES",
  "OTHER",
] as const;

const Schema = z.object({
  itemName: z.string().trim().min(1, "Item name is required").max(160),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  supplierName: z.string().trim().max(160).optional().or(z.literal("")),
  paidByPartnerId: z.string().optional().or(z.literal("")),
  cost: z.coerce.number().nonnegative("Cost must be ≥ 0"),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  category: z.enum(CATEGORIES),
  date: z.coerce.date(),
});

function parse(formData: FormData) {
  return Schema.safeParse({
    itemName: formData.get("itemName"),
    description: formData.get("description") ?? undefined,
    supplierName: formData.get("supplierName") ?? undefined,
    paidByPartnerId: formData.get("paidByPartnerId") ?? undefined,
    cost: formData.get("cost"),
    quantity: formData.get("quantity"),
    category: formData.get("category"),
    date: formData.get("date"),
  });
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : null);
const MODULE = "internal-purchases" as const;

export async function createInternalPurchase(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const workspaceId = gate.access.workspaceId;

  let paidByPartnerId: string | null = null;
  if (d.paidByPartnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.paidByPartnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    paidByPartnerId = partner.id;
  }

  await prisma.internalPurchase.create({
    data: {
      workspaceId,
      itemName: d.itemName,
      description: clean(d.description),
      supplierName: clean(d.supplierName),
      paidByPartnerId,
      cost: d.cost,
      quantity: d.quantity,
      category: d.category,
      date: d.date,
    },
  });
  revalidatePath(`/${slug}/internal-purchases`);
  return { ok: true };
}

export async function updateInternalPurchase(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const workspaceId = gate.access.workspaceId;

  let paidByPartnerId: string | null = null;
  if (d.paidByPartnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.paidByPartnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    paidByPartnerId = partner.id;
  }

  const res = await prisma.internalPurchase.updateMany({
    where: { id, workspaceId },
    data: {
      itemName: d.itemName,
      description: clean(d.description),
      supplierName: clean(d.supplierName),
      paidByPartnerId,
      cost: d.cost,
      quantity: d.quantity,
      category: d.category,
      date: d.date,
    },
  });
  if (res.count === 0) return { ok: false, error: "Entry not found" };
  revalidatePath(`/${slug}/internal-purchases`);
  return { ok: true };
}

export async function deleteInternalPurchase(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  await prisma.internalPurchase.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/internal-purchases`);
  return { ok: true };
}
