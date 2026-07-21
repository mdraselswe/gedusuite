"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

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
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, address, phone, altPhone, notes } = parsed.data;
  await prisma.supplier.create({
    data: {
      workspaceId: gate.access.workspaceId,
      name,
      address: address || null,
      phone: phone || null,
      altPhone: altPhone || null,
      notes: notes || null,
    },
  });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, address, phone, altPhone, notes } = parsed.data;
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
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function deleteSupplier(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  await prisma.supplier.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}
