"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_IMAGE_CHARS = 2_000_000; // ~1.5MB data URI

const imageField = z
  .string()
  .trim()
  .max(MAX_IMAGE_CHARS, "Image is too large (max ~1.5MB)")
  .refine((v) => v === "" || v.startsWith("data:image/"), "Invalid image")
  .optional();

const VariantInput = z.object({
  size: z.string().trim().max(60).optional().or(z.literal("")),
  color: z.string().trim().max(60).optional().or(z.literal("")),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
});

const ProductSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(300),
  category: z.string().trim().max(80).optional().or(z.literal("")),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  barcode: z.string().trim().max(60).optional().or(z.literal("")),
  imageUrl: imageField,
  expiryTracked: z.boolean(),
  lowStockThreshold: z.coerce.number().int().min(0).max(100000),
  // >1 enables Packet<->Piece conversion; blank/1 = plain per-piece product.
  unitsPerPack: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().min(2, "Units per pack must be at least 2").max(10000).optional(),
  ),
  variants: z.array(VariantInput).max(50),
});

function parseProduct(formData: FormData) {
  let variants: unknown = [];
  try {
    variants = JSON.parse(String(formData.get("variants") ?? "[]"));
  } catch {
    variants = [];
  }
  return ProductSchema.safeParse({
    name: formData.get("name"),
    category: formData.get("category") ?? undefined,
    sku: formData.get("sku") ?? undefined,
    barcode: formData.get("barcode") ?? undefined,
    imageUrl: formData.get("imageUrl") ?? undefined,
    expiryTracked: formData.get("expiryTracked") === "on" || formData.get("expiryTracked") === "true",
    lowStockThreshold: formData.get("lowStockThreshold") ?? 5,
    unitsPerPack: formData.get("unitsPerPack") ?? undefined,
    variants,
  });
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : null);

export async function createProduct(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "add");
  if (!gate.ok) return gate;

  const parsed = parseProduct(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  // Variants are optional. If the user didn't add any, create a single default
  // (empty) variant so stock/purchases/orders keep working uniformly against
  // ProductVariant without ever forcing variant fields in the UI.
  const meaningful = d.variants.filter((v) => v.size || v.color || v.sku);
  const variantCreate =
    meaningful.length > 0
      ? meaningful.map((v) => ({ size: clean(v.size), color: clean(v.color), sku: clean(v.sku) }))
      : [{ size: null, color: null, sku: null }];

  await prisma.product.create({
    data: {
      workspaceId: gate.access.workspaceId,
      name: d.name,
      category: clean(d.category),
      sku: clean(d.sku),
      barcode: clean(d.barcode),
      imageUrl: clean(d.imageUrl),
      expiryTracked: d.expiryTracked,
      lowStockThreshold: d.lowStockThreshold,
      unitsPerPack: d.unitsPerPack ?? null,
      variants: { create: variantCreate },
    },
  });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function updateProduct(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const parsed = parseProduct(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const result = await prisma.product.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: {
      name: d.name,
      category: clean(d.category),
      sku: clean(d.sku),
      barcode: clean(d.barcode),
      imageUrl: clean(d.imageUrl),
      expiryTracked: d.expiryTracked,
      lowStockThreshold: d.lowStockThreshold,
      unitsPerPack: d.unitsPerPack ?? null,
    },
  });
  if (result.count === 0) return { ok: false, error: "Product not found" };
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function deleteProduct(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const product = await prisma.product.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { id: true },
  });
  if (!product) return { ok: false, error: "Product not found" };

  // ProductVariant -> OrderItem is a RESTRICT fk: a variant that's ever been
  // sold can't be deleted (and Product delete cascades to variants), so check
  // first instead of letting the DB throw.
  const soldCount = await prisma.orderItem.count({
    where: { productVariant: { productId: id } },
  });
  if (soldCount > 0) {
    return {
      ok: false,
      error: "This product has been sold in past orders and can't be deleted. Remove unsold variants instead, or keep it for order history.",
    };
  }

  await prisma.product.delete({ where: { id } });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

const AddVariantSchema = VariantInput.refine(
  (v) => v.size || v.color || v.sku,
  "Enter a size, color, or SKU",
);

export async function addVariant(
  slug: string,
  productId: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const parsed = AddVariantSchema.safeParse({
    size: formData.get("size") ?? undefined,
    color: formData.get("color") ?? undefined,
    sku: formData.get("sku") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  // Confirm the product belongs to this workspace before attaching a variant.
  const product = await prisma.product.findFirst({
    where: { id: productId, workspaceId: gate.access.workspaceId },
    select: { id: true },
  });
  if (!product) return { ok: false, error: "Product not found" };

  await prisma.productVariant.create({
    data: {
      productId,
      size: clean(parsed.data.size),
      color: clean(parsed.data.color),
      sku: clean(parsed.data.sku),
    },
  });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function deleteVariant(
  slug: string,
  variantId: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  // Scope delete via the parent product's workspace.
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, product: { workspaceId: gate.access.workspaceId } },
    select: { id: true },
  });
  if (!variant) return { ok: false, error: "Variant not found" };

  // ProductVariant -> OrderItem is a RESTRICT fk: block with a clear message
  // instead of letting the raw DB constraint error surface.
  const soldCount = await prisma.orderItem.count({ where: { productVariantId: variantId } });
  if (soldCount > 0) {
    return {
      ok: false,
      error: "This variant has been sold in past orders and can't be deleted — it's kept for order history.",
    };
  }

  await prisma.productVariant.delete({ where: { id: variantId } });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

// ── Bulk JSON import ─────────────────────────────────────────────────

const ImportVariant = z.object({
  size: z.string().trim().max(60).optional().or(z.literal("")),
  color: z.string().trim().max(60).optional().or(z.literal("")),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
});

const ImportProduct = z.object({
  name: z.string().trim().min(1, "Every product needs a name").max(300, "Name is too long (max 300 characters)"),
  category: z.string().trim().max(80).optional().or(z.literal("")),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  barcode: z.string().trim().max(60).optional().or(z.literal("")),
  expiryTracked: z.boolean().optional().default(false),
  lowStockThreshold: z.coerce.number().int().min(0).max(100000).optional().default(5),
  unitsPerPack: z.coerce.number().int().min(2).max(10000).optional(),
  variants: z.array(ImportVariant).max(50).optional().default([]),
});

const ImportSchema = z.array(ImportProduct).min(1, "The file has no products").max(500, "Max 500 products per import");

export type ImportResult =
  | { ok: true; created: number; skipped: string[] }
  | { ok: false; error: string };

/**
 * Bulk-create products from a JSON array (see the import dialog for the
 * documented format). Products whose name already exists in the workspace
 * (case-insensitive) are skipped, so re-running the same file is safe.
 * Unknown categories are added to the workspace's category list.
 */
export async function importProducts(
  slug: string,
  jsonString: string,
): Promise<ImportResult> {
  const gate = await requireAccess(slug, "products", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  let data: unknown;
  try {
    data = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  const parsed = ImportSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: "Invalid format" };
    // Point at the exact product so a bad row in a big file is findable:
    // path is like [24, "name"] — show it as "Product #25, field name".
    const [idx, ...rest] = issue.path;
    if (typeof idx === "number") {
      const row = Array.isArray(data) ? (data[idx] as Record<string, unknown>) : undefined;
      const label =
        row && typeof row.name === "string" && row.name
          ? ` ("${row.name.slice(0, 40)}${row.name.length > 40 ? "…" : ""}")`
          : "";
      const field = rest.length ? `, field ${rest.join(".")}` : "";
      return { ok: false, error: `Product #${idx + 1}${label}${field}: ${issue.message}` };
    }
    return { ok: false, error: issue.message };
  }

  const existing = await prisma.product.findMany({
    where: { workspaceId },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

  const skipped: string[] = [];
  const toCreate: typeof parsed.data = [];
  const seenInFile = new Set<string>();
  for (const p of parsed.data) {
    const key = p.name.toLowerCase();
    if (existingNames.has(key) || seenInFile.has(key)) {
      skipped.push(p.name);
      continue;
    }
    seenInFile.add(key);
    toCreate.push(p);
  }

  const categories = [
    ...new Set(toCreate.map((p) => clean(p.category)).filter((c): c is string => !!c)),
  ];

  await prisma.$transaction(
    async (tx) => {
      // Keep the category dropdown consistent with imported values.
      if (categories.length) {
        await tx.productCategory.createMany({
          data: categories.map((name) => ({ workspaceId, name })),
          skipDuplicates: true,
        });
      }
      for (const p of toCreate) {
        const meaningful = (p.variants ?? []).filter((v) => v.size || v.color || v.sku);
        await tx.product.create({
          data: {
            workspaceId,
            name: p.name,
            category: clean(p.category),
            sku: clean(p.sku),
            barcode: clean(p.barcode),
            expiryTracked: p.expiryTracked ?? false,
            lowStockThreshold: p.lowStockThreshold ?? 5,
            unitsPerPack: p.unitsPerPack ?? null,
            variants: {
              create:
                meaningful.length > 0
                  ? meaningful.map((v) => ({
                      size: clean(v.size),
                      color: clean(v.color),
                      sku: clean(v.sku),
                    }))
                  : [{ size: null, color: null, sku: null }],
            },
          },
        });
      }
    },
    { timeout: 60_000 },
  );

  revalidatePath(`/${slug}/products`);
  return { ok: true, created: toCreate.length, skipped };
}
