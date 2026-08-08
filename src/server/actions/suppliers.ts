"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { failed, type ActionFailure } from "@/lib/form";
import { diffFields, recordActivity } from "@/lib/activity";

export type ActionResult =
  | { ok: true; id?: string; name?: string }
  | ActionFailure;

const SupplierSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  altPhone: z.string().trim().max(40).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

function parse(formData: FormData) {
  return SupplierSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    altPhone: formData.get("altPhone") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  });
}

export async function createSupplier(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "add");
  if (!gate.ok) return gate;

  const parsed = parse(formData);
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const { name, address, phone, altPhone, notes } = parsed.data;
  const created = await prisma.supplier.create({
    data: {
      workspaceId: gate.access.workspaceId,
      name,
      address: address || null,
      phone: phone || null,
      altPhone: altPhone || null,
      notes: notes || null,
    },
  });
  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "Supplier",
    entityId: created.id,
    entityLabel: created.name,
    summary: "Added",
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true, id: created.id, name: created.name };
}

export async function updateSupplier(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const parsed = parse(formData);
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const { name, address, phone, altPhone, notes } = parsed.data;
  const before = await prisma.supplier.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { name: true, address: true, phone: true, altPhone: true, notes: true },
  });
  // Scope by workspaceId so one workspace can't edit another's rows.
  const result = await prisma.supplier.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: {
      name,
      address: address || null,
      phone: phone || null,
      altPhone: altPhone || null,
      notes: notes || null,
    },
  });
  if (result.count === 0) return { ok: false, error: "Supplier not found" };

  const changes = before
    ? diffFields(
        before,
        { name, address: address || null, phone: phone || null, altPhone: altPhone || null, notes: notes || null },
        ["name", "address", "phone", "altPhone", "notes"],
      )
    : null;
  if (changes) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Supplier",
      entityId: id,
      entityLabel: name,
      summary: "Edited",
      changes,
    });
  }

  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function deleteSupplier(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const existing = await prisma.supplier.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { name: true },
  });
  await prisma.supplier.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  if (existing) {
    await recordActivity(gate.access, {
      action: "DELETE",
      entity: "Supplier",
      entityId: id,
      entityLabel: existing.name,
      summary: "Deleted",
    });
  }
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}
