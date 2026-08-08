"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { failed, type ActionFailure } from "@/lib/form";
import { diffFields, recordActivity } from "@/lib/activity";
import { variantFullName } from "@/lib/variants";

export type ActionResult = { ok: true } | ActionFailure;

/**
 * Why a product or variant with purchase history can't be deleted, with the
 * money named. "Can't delete this" invites someone to look for a way around
 * it; "this would erase 8,000.00 of buying history" explains itself.
 */
function purchaseHistoryError(
  purchases: { unitCost: unknown; quantity: number }[],
  kind: "product" | "variant",
): string {
  const total = purchases.reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0);
  return (
    `This ${kind} has ${purchases.length} purchase record(s) worth ${total.toFixed(2)} and can't be deleted — ` +
    `that would erase the buying history, and the investment credit for whoever paid for it. ` +
    `Delete those purchases first if the ${kind} really was entered by mistake.`
  );
}

const MAX_IMAGE_CHARS = 2_000_000; // ~1.5MB data URI

const imageField = z
  .string()
  .trim()
  .max(MAX_IMAGE_CHARS, "Image is too large (max ~1.5MB)")
  .refine((v) => v === "" || v.startsWith("data:image/"), "Invalid image")
  .optional();

// Optional money field: "" / null -> undefined, else a non-negative number.
const priceField = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce.number().nonnegative("Price must be ≥ 0").max(1_000_000_000).optional(),
);
// Optional per-variant low-stock override: "" / null -> undefined.
const variantThresholdField = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce.number().int().min(0).max(100000).optional(),
);

const AttributeInput = z.object({
  name: z.string().trim().max(40),
  value: z.string().trim().max(80),
});

const VariantInput = z.object({
  // Present for variants that already exist (used to update in place); absent
  // for brand-new rows.
  id: z.string().optional(),
  attributes: z.array(AttributeInput).max(20).optional().default([]),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  barcode: z.string().trim().max(60).optional().or(z.literal("")),
  description: z.string().trim().max(300).optional().or(z.literal("")),
  salePrice: priceField,
  unitCost: priceField,
  lowStockThreshold: variantThresholdField,
  imageUrl: imageField,
});

type VariantInputData = z.infer<typeof VariantInput>;

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
  // Shipping weight of one piece, in grams — feeds the courier quote.
  weightGrams: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().min(0).max(1_000_000).optional(),
  ),
  // Ordered attribute names this product varies on, e.g. ["Size","Color"].
  attributeNames: z.array(z.string().trim().max(40)).max(20).optional().default([]),
  variants: z.array(VariantInput).max(200),
});

function parseJson(formData: FormData, key: string): unknown {
  try {
    return JSON.parse(String(formData.get(key) ?? "[]"));
  } catch {
    return [];
  }
}

function parseProduct(formData: FormData) {
  return ProductSchema.safeParse({
    name: formData.get("name"),
    category: formData.get("category") ?? undefined,
    sku: formData.get("sku") ?? undefined,
    barcode: formData.get("barcode") ?? undefined,
    imageUrl: formData.get("imageUrl") ?? undefined,
    expiryTracked: formData.get("expiryTracked") === "on" || formData.get("expiryTracked") === "true",
    lowStockThreshold: formData.get("lowStockThreshold") ?? 5,
    unitsPerPack: formData.get("unitsPerPack") ?? undefined,
    weightGrams: formData.get("weightGrams") ?? undefined,
    attributeNames: parseJson(formData, "attributeNames"),
    variants: parseJson(formData, "variants"),
  });
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : null);

// Keep only attributes with a non-empty value; trim names/values.
function cleanAttributes(attrs: { name: string; value: string }[] = []) {
  return attrs
    .map((a) => ({ name: a.name.trim(), value: a.value.trim() }))
    .filter((a) => a.value !== "");
}

const cleanNames = (names: string[] = []) =>
  names.map((n) => n.trim()).filter((n) => n !== "");

// Shape a validated variant into ProductVariant column data.
function variantData(v: VariantInputData) {
  return {
    attributes: cleanAttributes(v.attributes),
    sku: clean(v.sku),
    barcode: clean(v.barcode),
    description: clean(v.description),
    salePrice: v.salePrice ?? null,
    unitCost: v.unitCost ?? null,
    lowStockThreshold: v.lowStockThreshold ?? null,
    imageUrl: clean(v.imageUrl),
  };
}

export async function createProduct(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "add");
  if (!gate.ok) return gate;

  const parsed = parseProduct(formData);
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  // Variants are optional. If the user didn't add any, create a single default
  // (attribute-less) variant so stock/purchases/orders keep working uniformly
  // against ProductVariant. A single default variant can still carry pricing.
  const variantCreate =
    d.variants.length > 0
      ? d.variants.map(variantData)
      : [variantData({ attributes: [] } as VariantInputData)];

  const created = await prisma.product.create({
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
      weightGrams: d.weightGrams ?? null,
      attributeNames: cleanNames(d.attributeNames),
      variants: { create: variantCreate },
    },
  });

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "Product",
    entityId: created.id,
    entityLabel: d.name,
    summary: `Added — ${variantCreate.length} variant(s)`,
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
    return failed(parsed.error);
  }
  const d = parsed.data;

  // Scope check up front so we can safely reconcile this product's variants.
  const product = await prisma.product.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: {
      id: true,
      variants: { select: { id: true } },
      name: true,
      category: true,
      sku: true,
      barcode: true,
      expiryTracked: true,
      lowStockThreshold: true,
      unitsPerPack: true,
      weightGrams: true,
    },
  });
  if (!product) return { ok: false, error: "Product not found" };
  const existingIds = new Set(product.variants.map((v) => v.id));

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        name: d.name,
        category: clean(d.category),
        sku: clean(d.sku),
        barcode: clean(d.barcode),
        imageUrl: clean(d.imageUrl),
        expiryTracked: d.expiryTracked,
        lowStockThreshold: d.lowStockThreshold,
        unitsPerPack: d.unitsPerPack ?? null,
        weightGrams: d.weightGrams ?? null,
        attributeNames: cleanNames(d.attributeNames),
      },
    });

    // Reconcile variants: update existing rows in place, create brand-new ones.
    // Deletion is intentionally NOT done here — it goes through deleteVariant,
    // which guards variants that have already been sold.
    for (const v of d.variants) {
      const data = variantData(v);
      if (v.id && existingIds.has(v.id)) {
        await tx.productVariant.update({ where: { id: v.id }, data });
      } else {
        await tx.productVariant.create({ data: { productId: id, ...data } });
      }
    }
  });

  const productChanges = diffFields(
    product,
    {
      name: d.name,
      category: clean(d.category),
      sku: clean(d.sku),
      barcode: clean(d.barcode),
      expiryTracked: d.expiryTracked,
      lowStockThreshold: d.lowStockThreshold,
      unitsPerPack: d.unitsPerPack ?? null,
      weightGrams: d.weightGrams ?? null,
    },
    ["name", "category", "sku", "barcode", "expiryTracked", "lowStockThreshold", "unitsPerPack", "weightGrams"],
  );
  const newVariants = d.variants.filter((v) => !v.id || !existingIds.has(v.id)).length;
  if (productChanges || newVariants > 0) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Product",
      entityId: id,
      entityLabel: d.name,
      // Variant prices live on their own rows; saying how many appeared keeps
      // the line honest without listing every one.
      summary: newVariants > 0 ? `Edited — ${newVariants} new variant(s)` : "Edited",
      changes: productChanges,
    });
  }

  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

export async function deleteProduct(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const product = await prisma.product.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { id: true, name: true },
  });
  if (!product) return { ok: false, error: "Product not found" };

  // ProductVariant -> OrderItem is a RESTRICT fk: a variant that's ever been
  // sold can't be deleted (and Product delete cascades to variants), so check
  // first instead of letting the DB throw.
  //
  // Purchase is NOT restricted — it cascades — which is why it's checked here
  // by hand. A product bought but never sold used to delete cleanly and take
  // its purchase rows with it, and with them the partner's investment credit
  // for the money they put in to buy it. Money spent would simply stop having
  // been spent.
  const [soldCount, purchases] = await Promise.all([
    prisma.orderItem.count({ where: { productVariant: { productId: id } } }),
    prisma.purchase.findMany({
      where: { productVariant: { productId: id } },
      select: { unitCost: true, quantity: true },
    }),
  ]);
  if (soldCount > 0) {
    return {
      ok: false,
      error: "This product has been sold in past orders and can't be deleted. Remove unsold variants instead, or keep it for order history.",
    };
  }
  if (purchases.length > 0) {
    return { ok: false, error: purchaseHistoryError(purchases, "product") };
  }

  await prisma.product.delete({ where: { id } });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "Product",
    entityId: id,
    entityLabel: product.name,
    summary: "Deleted — it had never been sold or bought",
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

const AddVariantSchema = VariantInput.refine(
  (v) => cleanAttributes(v.attributes).length > 0 || v.sku,
  "Enter at least one attribute value or a SKU",
);

export async function addVariant(
  slug: string,
  productId: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const parsed = AddVariantSchema.safeParse(parseJson(formData, "variant"));
  if (!parsed.success) {
    return failed(parsed.error);
  }
  // Confirm the product belongs to this workspace before attaching a variant.
  const product = await prisma.product.findFirst({
    where: { id: productId, workspaceId: gate.access.workspaceId },
    select: { id: true, name: true },
  });
  if (!product) return { ok: false, error: "Product not found" };

  const variant = await prisma.productVariant.create({
    data: { productId, ...variantData(parsed.data) },
  });

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "ProductVariant",
    entityId: variant.id,
    entityLabel: variantFullName(product.name, variant.attributes),
    summary: "Variant added",
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
    select: { id: true, attributes: true, product: { select: { name: true } } },
  });
  if (!variant) return { ok: false, error: "Variant not found" };

  // ProductVariant -> OrderItem is a RESTRICT fk: block with a clear message
  // instead of letting the raw DB constraint error surface. Purchase cascades
  // rather than restricting, so it needs the same check made by hand — see
  // deleteProduct above for what that silently destroyed.
  const [soldCount, purchases] = await Promise.all([
    prisma.orderItem.count({ where: { productVariantId: variantId } }),
    prisma.purchase.findMany({
      where: { productVariantId: variantId },
      select: { unitCost: true, quantity: true },
    }),
  ]);
  if (soldCount > 0) {
    return {
      ok: false,
      error: "This variant has been sold in past orders and can't be deleted — it's kept for order history.",
    };
  }
  if (purchases.length > 0) {
    return { ok: false, error: purchaseHistoryError(purchases, "variant") };
  }

  await prisma.productVariant.delete({ where: { id: variantId } });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "ProductVariant",
    entityId: variantId,
    entityLabel: variantFullName(variant.product.name, variant.attributes),
    summary: "Variant deleted — it had never been sold or bought",
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

// ── Bulk JSON import ─────────────────────────────────────────────────

const ImportVariant = z.object({
  // Legacy shorthand — still accepted and converted to attributes on import.
  size: z.string().trim().max(80).optional().or(z.literal("")),
  color: z.string().trim().max(80).optional().or(z.literal("")),
  // New flexible form.
  attributes: z.array(AttributeInput).max(20).optional().default([]),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  barcode: z.string().trim().max(60).optional().or(z.literal("")),
  description: z.string().trim().max(300).optional().or(z.literal("")),
  salePrice: priceField,
  unitCost: priceField,
  lowStockThreshold: variantThresholdField,
});

// Legacy size/color -> attributes; explicit attributes win when both present.
function importVariantAttributes(v: z.infer<typeof ImportVariant>) {
  const attrs = cleanAttributes(v.attributes);
  if (attrs.length) return attrs;
  const legacy: { name: string; value: string }[] = [];
  if (v.size?.trim()) legacy.push({ name: "Size", value: v.size.trim() });
  if (v.color?.trim()) legacy.push({ name: "Color", value: v.color.trim() });
  return legacy;
}

const ImportProduct = z.object({
  name: z.string().trim().min(1, "Every product needs a name").max(300, "Name is too long (max 300 characters)"),
  category: z.string().trim().max(80).optional().or(z.literal("")),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  barcode: z.string().trim().max(60).optional().or(z.literal("")),
  expiryTracked: z.boolean().optional().default(false),
  lowStockThreshold: z.coerce.number().int().min(0).max(100000).optional().default(5),
  unitsPerPack: z.coerce.number().int().min(2).max(10000).optional(),
  attributeNames: z.array(z.string().trim().max(40)).max(20).optional(),
  variants: z.array(ImportVariant).max(200).optional().default([]),
});

const ImportSchema = z.array(ImportProduct).min(1, "The file has no products").max(500, "Max 500 products per import");

export type ImportResult =
  | { ok: true; created: number; skipped: string[] }
  | ActionFailure;

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
        const variantRows = (p.variants ?? []).map((v) => ({
          attributes: importVariantAttributes(v),
          sku: clean(v.sku),
          barcode: clean(v.barcode),
          description: clean(v.description),
          salePrice: v.salePrice ?? null,
          unitCost: v.unitCost ?? null,
          lowStockThreshold: v.lowStockThreshold ?? null,
        }));
        // Explicit attributeNames win; otherwise derive from the variants' attrs.
        const names = cleanNames(p.attributeNames ?? []);
        const attributeNames = names.length
          ? names
          : [...new Set(variantRows.flatMap((r) => r.attributes.map((a) => a.name)))];
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
            attributeNames,
            variants: {
              create: variantRows.length > 0 ? variantRows : [{ attributes: [] }],
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
