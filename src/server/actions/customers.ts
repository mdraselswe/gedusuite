"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { normalizePhone } from "@/lib/phone";
import { failed, type ActionFailure } from "@/lib/form";
import { diffFields, recordActivity } from "@/lib/activity";

export type ActionResult = { ok: true } | ActionFailure;

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

// Stored normalised so the same person typed two different ways still matches.
const cleanPhone = (s?: string) => normalizePhone(s);

export async function createCustomer(
  slug: string,
  formData: FormData,
): Promise<ActionResult & { id?: string; name?: string; phone?: string | null }> {
  const gate = await requireAccess(slug, "customers", "add");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;
  const customer = await prisma.customer.create({
    data: {
      workspaceId: gate.access.workspaceId,
      name: d.name,
      phone: cleanPhone(d.phone),
      altPhone: cleanPhone(d.altPhone),
      address: clean(d.address),
      notes: clean(d.notes),
    },
  });
  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "Customer",
    entityId: customer.id,
    entityLabel: customer.name,
    summary: "Added",
  });

  revalidatePath(`/${slug}/customers`);
  // id/name/phone let callers (the order form's inline "+ New customer")
  // select the fresh customer immediately without a refetch.
  return { ok: true, id: customer.id, name: customer.name, phone: customer.phone };
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
    return failed(parsed.error);
  }
  const d = parsed.data;
  const before = await prisma.customer.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { name: true, phone: true, altPhone: true, address: true, notes: true },
  });
  const res = await prisma.customer.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: {
      name: d.name,
      phone: cleanPhone(d.phone),
      altPhone: cleanPhone(d.altPhone),
      address: clean(d.address),
      notes: clean(d.notes),
    },
  });
  if (res.count === 0) return { ok: false, error: "Customer not found" };

  const changes = before
    ? diffFields(
        before,
        {
          name: d.name,
          phone: cleanPhone(d.phone),
          altPhone: cleanPhone(d.altPhone),
          address: clean(d.address),
          notes: clean(d.notes),
        },
        ["name", "phone", "altPhone", "address", "notes"],
      )
    : null;
  if (changes) {
    // A changed delivery address is the one that shows up later as "why did
    // this parcel go to the wrong place".
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Customer",
      entityId: id,
      entityLabel: d.name,
      summary: "Edited",
      changes,
    });
  }

  revalidatePath(`/${slug}/customers`);
  return { ok: true };
}

/**
 * Find an existing customer on this number, so the same person doesn't become
 * two rows with half their order history each.
 *
 * Matches on the normalised form and on altPhone too — plenty of people order
 * once from their own number and once from the one they listed as alternate.
 * Purely advisory: callers warn or link, nothing here blocks a create, because
 * a genuinely shared family or shop number has to stay possible.
 */
export async function findCustomerByPhone(
  slug: string,
  phone: string,
): Promise<{ id: string; name: string; phone: string | null } | null> {
  const gate = await requireAccess(slug, "customers", "view");
  if (!gate.ok) return null;

  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  return prisma.customer.findFirst({
    where: {
      workspaceId: gate.access.workspaceId,
      OR: [{ phone: normalized }, { altPhone: normalized }],
    },
    select: { id: true, name: true, phone: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function deleteCustomer(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "customers", "edit");
  if (!gate.ok) return gate;
  const existing = await prisma.customer.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { name: true },
  });
  await prisma.customer.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  if (existing) {
    await recordActivity(gate.access, {
      action: "DELETE",
      entity: "Customer",
      entityId: id,
      entityLabel: existing.name,
      summary: "Deleted",
    });
  }
  revalidatePath(`/${slug}/customers`);
  return { ok: true };
}
