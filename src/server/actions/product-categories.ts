"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Baseline categories for a baby-products business (GeduShop). Seeded once
// per workspace the first time its category list is empty — existing
// workspaces get seeded retroactively the first time they load the Products
// page, new workspaces get them immediately.
const DEFAULT_CATEGORIES = [
  "Baby Clothing",
  "Diapers",
  "Feeding & Nursing",
  "Baby Food & Formula",
  "Toys",
  "Skincare & Bath",
  "Strollers & Carriers",
  "Health & Safety",
  "Nursery & Bedding",
  "Other",
];

/** Return this workspace's category list, seeding the defaults if it's empty. */
export async function listProductCategories(slug: string): Promise<string[]> {
  const gate = await requireAccess(slug, "products", "view");
  if (!gate.ok) return [];
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.productCategory.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  if (existing.length > 0) return existing.map((c) => c.name);

  // Empty — seed defaults. skipDuplicates guards a race if two requests both
  // see zero rows and try to seed at once.
  await prisma.productCategory.createMany({
    data: DEFAULT_CATEGORIES.map((name) => ({ workspaceId, name })),
    skipDuplicates: true,
  });
  const seeded = await prisma.productCategory.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  return seeded.map((c) => c.name);
}

const NameSchema = z.string().trim().min(1, "Category name is required").max(60);

export type CreateCategoryResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Add a custom category to the workspace's list. Products can use it right away. */
export async function createProductCategory(
  slug: string,
  name: string,
): Promise<CreateCategoryResult> {
  const gate = await requireAccess(slug, "products", "add");
  if (!gate.ok) return gate;

  const parsed = NameSchema.safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name" };
  }
  const clean = parsed.data;

  const existing = await prisma.productCategory.findFirst({
    where: { workspaceId: gate.access.workspaceId, name: { equals: clean, mode: "insensitive" } },
  });
  if (existing) {
    // Already exists (maybe different casing) — just use it, not an error.
    revalidatePath(`/${slug}/products`);
    return { ok: true, name: existing.name };
  }

  await prisma.productCategory.create({
    data: { workspaceId: gate.access.workspaceId, name: clean },
  });
  revalidatePath(`/${slug}/products`);
  return { ok: true, name: clean };
}

export async function deleteProductCategory(slug: string, name: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;
  await prisma.productCategory.deleteMany({
    where: { workspaceId: gate.access.workspaceId, name },
  });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}
