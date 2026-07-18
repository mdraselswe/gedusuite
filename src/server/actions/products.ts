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
  name: z.string().trim().min(1, "Name is required").max(160),
  category: z.string().trim().max(80).optional().or(z.literal("")),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  barcode: z.string().trim().max(60).optional().or(z.literal("")),
  imageUrl: imageField,
  expiryTracked: z.boolean(),
  lowStockThreshold: z.coerce.number().int().min(0).max(100000),
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
      variants: {
        create: d.variants
          .filter((v) => v.size || v.color || v.sku)
          .map((v) => ({ size: clean(v.size), color: clean(v.color), sku: clean(v.sku) })),
      },
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
    },
  });
  if (result.count === 0) return { ok: false, error: "Product not found" };
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function deleteProduct(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;
  await prisma.product.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
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

  await prisma.productVariant.delete({ where: { id: variantId } });
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}
