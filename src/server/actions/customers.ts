"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

const CustomerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  altPhone: z.string().trim().max(40).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

function parse(formData: FormData) {
  return CustomerSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone") ?? undefined,
    altPhone: formData.get("altPhone") ?? undefined,
    address: formData.get("address") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  });
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : null);

export async function createCustomer(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "customers", "add");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  await prisma.customer.create({
    data: {
      workspaceId: gate.access.workspaceId,
      name: d.name,
      phone: clean(d.phone),
      altPhone: clean(d.altPhone),
      address: clean(d.address),
      notes: clean(d.notes),
    },
  });
  revalidatePath(`/${slug}/customers`);
  return { ok: true };
}

export async function updateCustomer(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "customers", "edit");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const res = await prisma.customer.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: {
      name: d.name,
      phone: clean(d.phone),
      altPhone: clean(d.altPhone),
      address: clean(d.address),
      notes: clean(d.notes),
    },
  });
  if (res.count === 0) return { ok: false, error: "Customer not found" };
  revalidatePath(`/${slug}/customers`);
  return { ok: true };
}

export async function deleteCustomer(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "customers", "edit");
  if (!gate.ok) return gate;
  await prisma.customer.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/customers`);
  return { ok: true };
}
