"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { failed, checkboxField, type ActionFailure } from "@/lib/form";
import { recordActivity, diffFields } from "@/lib/activity";
import { variantCost, variantListPrice, variantStockMap } from "@/lib/inventory";
import {
  allocateComboPrice,
  componentsTotal,
} from "@/lib/combos";
import { variantFullName } from "@/lib/variants";
import { loadFlexibleComboVariants } from "@/lib/combo-variants";
import { allocateFlexiblePrice, recipeBuildable, withProductVariants, comboWebsiteRecipe, type RecipeComponent } from "@/lib/flexible-combos";
import { round2 } from "@/lib/money";

export type ActionResult = { ok: true; id?: string } | ActionFailure;

const ComponentSchema = z.object({
  productVariantId: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
});

const ComboSchema = z.object({
  name: z.string().trim().min(1, "Give the combo a name").max(120),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  imageUrl: z.string().trim().optional().or(z.literal("")),
  price: z.coerce.number().positive("Set the combo's price"),
  freeDelivery: checkboxField,
  flexibleVariants: checkboxField,
  active: checkboxField,
  // Typed by hand — combos are built separately in both places — so an empty
  // box has to mean "phone-only combo", not product id 0.
  wooProductId: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  validFrom: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.date().optional(),
  ),
  validTo: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.date().optional(),
  ),
  /**
   * Two pieces, which is not the same as two products.
   *
   * One product taken twice at the price of one is the whole of "buy one get
   * one free", and the rest of a combo's machinery already handles it: the
   * shelf makes floor(stock / 2) of them, the saving comes out at half, and an
   * order still writes down two pieces of an ordinary product. Requiring two
   * *products* refused that for no reason.
   *
   * One piece is still refused. A single product at its own quantity of one,
   * sold at a different price, is not a set — it is that product's price, and
   * changing it there is the honest place.
   */
  items: z
    .array(ComponentSchema)
    .min(1, "Add a product to the combo")
    .refine((items) => items.reduce((n, i) => n + i.quantity, 0) >= 2, {
      message:
        "A combo needs at least two pieces. One product twice is fine — that is a buy-one-get-one; one piece on its own is just a price.",
    }),
});

/** Read the form once; create and update parse the same shape. */
function parseCombo(formData: FormData) {
  let itemsRaw: unknown = [];
  try {
    itemsRaw = JSON.parse(String(formData.get("items") ?? "[]"));
  } catch {
    itemsRaw = [];
  }
  return ComboSchema.safeParse({
    name: formData.get("name"),
    sku: formData.get("sku") ?? undefined,
    imageUrl: formData.get("imageUrl") ?? undefined,
    price: formData.get("price"),
    freeDelivery: formData.get("freeDelivery"),
    flexibleVariants: formData.get("flexibleVariants"),
    active: formData.get("active"),
    wooProductId: formData.get("wooProductId") ?? undefined,
    validFrom: formData.get("validFrom") ?? undefined,
    validTo: formData.get("validTo") ?? undefined,
    items: itemsRaw,
  });
}

/**
 * Every component must belong to this workspace, and none of them twice.
 *
 * The duplicate check is not tidiness. The same variant listed twice would hit
 * the (comboSetId, productVariantId) unique index and surface as a Prisma
 * error nobody can read, and it means something the form says better anyway:
 * three batteries is a quantity, not three rows.
 */
async function validateComponents(
  workspaceId: string,
  items: { productVariantId: string; quantity: number }[],
): Promise<{ ok: true } | ActionFailure> {
  const ids = items.map((i) => i.productVariantId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "The same product is listed twice — set its quantity instead" };
  }
  const found = await prisma.productVariant.count({
    where: { id: { in: ids }, product: { workspaceId } },
  });
  if (found !== ids.length) {
    return { ok: false, error: "One or more products in this combo are invalid" };
  }
  return { ok: true };
}

/** Turn a unique-constraint failure on wooProductId into a sentence. */
function wooIdTaken(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "P2002" &&
    String((e as { meta?: { target?: unknown } }).meta?.target ?? "").includes("wooProductId")
  );
}

const WOO_ID_TAKEN = "Another combo is already linked to that website product id";

export async function createCombo(slug: string, formData: FormData): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = parseCombo(formData);
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;

  const valid = await validateComponents(workspaceId, d.items);
  if (!valid.ok) return valid;

  let created: { id: string };
  try {
    created = await prisma.comboSet.create({
      data: {
        workspaceId,
        name: d.name,
        sku: d.sku?.trim() || null,
        imageUrl: d.imageUrl?.trim() || null,
        price: d.price,
        freeDelivery: d.freeDelivery,
        flexibleVariants: d.flexibleVariants,
        active: d.active,
        wooProductId: d.wooProductId ?? null,
        validFrom: d.validFrom ?? null,
        validTo: d.validTo ?? null,
        items: {
          create: d.items.map((i) => ({
            productVariantId: i.productVariantId,
            quantity: i.quantity,
          })),
        },
      },
      select: { id: true },
    });
  } catch (e) {
    if (wooIdTaken(e)) return { ok: false, error: WOO_ID_TAKEN, field: "wooProductId" };
    throw e;
  }

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "ComboSet",
    entityId: created.id,
    entityLabel: d.name,
    summary: `Created — ${d.items.length} products at ${d.price.toFixed(2)}`,
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true, id: created.id };
}

export async function updateCombo(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.comboSet.findFirst({
    where: { id, workspaceId },
    include: { items: { select: { productVariantId: true, quantity: true } } },
  });
  if (!existing) return { ok: false, error: "Combo not found" };

  const parsed = parseCombo(formData);
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;

  const valid = await validateComponents(workspaceId, d.items);
  if (!valid.ok) return valid;

  // Components are replaced wholesale rather than diffed. Nothing points at a
  // ComboItem — an order keeps only the recipe's id, and the pieces it sold are
  // its own OrderItem rows — so there is no history here to preserve, and a
  // delete-then-create is one obvious operation instead of three subtle ones.
  try {
    await prisma.$transaction([
      prisma.comboItem.deleteMany({ where: { comboSetId: id } }),
      prisma.comboSet.update({
        where: { id },
        data: {
          name: d.name,
          sku: d.sku?.trim() || null,
          imageUrl: d.imageUrl?.trim() || null,
          price: d.price,
          freeDelivery: d.freeDelivery,
          flexibleVariants: d.flexibleVariants,
          active: d.active,
          wooProductId: d.wooProductId ?? null,
          validFrom: d.validFrom ?? null,
          validTo: d.validTo ?? null,
          items: {
            create: d.items.map((i) => ({
              productVariantId: i.productVariantId,
              quantity: i.quantity,
            })),
          },
        },
      }),
    ]);
  } catch (e) {
    if (wooIdTaken(e)) return { ok: false, error: WOO_ID_TAKEN, field: "wooProductId" };
    throw e;
  }

  const changes = diffFields(
    {
      name: existing.name,
      price: existing.price,
      freeDelivery: existing.freeDelivery,
      flexibleVariants: existing.flexibleVariants,
      active: existing.active,
      wooProductId: existing.wooProductId,
      validFrom: existing.validFrom,
      validTo: existing.validTo,
      items: existing.items.length,
    },
    {
      name: d.name,
      price: d.price,
      freeDelivery: d.freeDelivery,
      flexibleVariants: d.flexibleVariants,
      active: d.active,
      wooProductId: d.wooProductId ?? null,
      validFrom: d.validFrom ?? null,
      validTo: d.validTo ?? null,
      items: d.items.length,
    },
    ["name", "price", "flexibleVariants", "freeDelivery", "active", "wooProductId", "validFrom", "validTo", "items"],
  );

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "ComboSet",
    entityId: id,
    entityLabel: d.name,
    summary: "Combo updated",
    changes,
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true, id };
}

/**
 * Delete a combo.
 *
 * Orders that sold it are untouched: they hold ordinary component lines and a
 * plain `comboSetId` string, never a foreign key, so the history survives the
 * recipe. What is lost is the report's name for it, which is why switching a
 * combo off is offered first and this is the deliberate second choice.
 */
export async function deleteCombo(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "full");
  if (!gate.ok) return gate;

  const existing = await prisma.comboSet.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { id: true, name: true },
  });
  if (!existing) return { ok: false, error: "Combo not found" };

  await prisma.comboSet.delete({ where: { id } });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "ComboSet",
    entityId: id,
    entityLabel: existing.name,
    summary: "Combo deleted",
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true };
}

/** Quick on/off from the list, without opening the whole form. */
export async function setComboActive(
  slug: string,
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const existing = await prisma.comboSet.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { id: true, name: true, active: true },
  });
  if (!existing) return { ok: false, error: "Combo not found" };
  if (existing.active === active) return { ok: true, id };

  await prisma.comboSet.update({ where: { id }, data: { active } });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "ComboSet",
    entityId: id,
    entityLabel: existing.name,
    summary: active ? "Combo switched on" : "Combo switched off",
    changes: { active: { from: existing.active, to: active } },
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true, id };
}

/** A combo as the order form needs it: priced, countable, and pre-allocated. */
export type ComboOptionForOrder = {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  freeDelivery: boolean;
  flexibleVariants: boolean;
  /** How many complete sets the shelf can make right now. */
  buildable: number;
  /** What the same goods list for bought separately. */
  listTotal: number;
  components: {
    productVariantId: string;
    productId: string;
    productName: string;
    label: string;
    quantity: number;
    salePrice: number | null;
    stock: number;
    /** One piece's shipping weight, so a combo parcel can be weighed like any other. */
    weightGrams: number | null;
  }[];
  /** One set's recipe allocation; flexible sales resolve their actual mix separately. */
  allocation: { productVariantId: string; quantity: number; unitPrice: number; discount: number }[];
};

/**
 * Combos the order form may offer right now.
 *
 * Switched-off combos and ones outside their promotion window are left out
 * rather than shown greyed: a promotion that has ended is not something a
 * seller should be able to put on an order by mistake. Sold-out ones ARE
 * returned, with `buildable: 0` — "Flight Combo, none left" is information,
 * and a row that simply vanished is a mystery.
 */
/**
 * The three numbers the combo form needs about a component.
 *
 * The form used to take them from whatever the product search happened to
 * return, and the products page worked them out its own way, so a combo could
 * quote one "bought separately" while it was being built and another when it
 * was reopened to edit — the same goods, two answers. Both sides now ask here.
 */
export type ComponentFacts = {
  productId: string;
  alternatives: (RecipeComponent & { stock: number })[];
  /** Null when nobody has ever priced this piece on its own. */
  salePrice: number | null;
  unitCost: number;
  stock: number;
};

export async function comboComponentFacts(
  slug: string,
  variantIds: string[],
): Promise<{ ok: true; facts: Record<string, ComponentFacts> } | ActionFailure> {
  const gate = await requireAccess(slug, "products", "view");
  if (!gate.ok) return gate;
  if (variantIds.length === 0) return { ok: true, facts: {} };

  const ids = [...new Set(variantIds)];
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: ids }, product: { workspaceId: gate.access.workspaceId } },
    select: {
      id: true, productId: true, salePrice: true, unitCost: true,
      purchases: { orderBy: { date: "desc" }, take: 1, select: { unitCost: true, salePrice: true } },
      product: { select: { variants: { select: { id: true, productId: true, salePrice: true } } } },
    },
  });
  const stock = await variantStockMap(gate.access.workspaceId,
    [...new Set(variants.flatMap((v) => v.product.variants.map((s) => s.id)))]);

  const facts: Record<string, ComponentFacts> = {};
  for (const v of variants) {
    facts[v.id] = {
      productId: v.productId,
      alternatives: v.product.variants.map((s) => ({
        productVariantId: s.id, productId: s.productId, quantity: 0,
        salePrice: s.salePrice == null ? null : Number(s.salePrice), stock: stock.get(s.id) ?? 0,
      })),
      salePrice: variantListPrice(v),
      unitCost: variantCost(v),
      stock: stock.get(v.id) ?? 0,
    };
  }
  return { ok: true, facts };
}

export async function listCombosForOrder(slug: string): Promise<ComboOptionForOrder[]> {
  const gate = await requireAccess(slug, "sales", "view");
  if (!gate.ok) return [];
  const workspaceId = gate.access.workspaceId;

  const now = new Date();
  const combos = await prisma.comboSet.findMany({
    where: {
      workspaceId,
      active: true,
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validTo: null }, { validTo: { gte: now } }] },
      ],
    },
    orderBy: { name: "asc" },
    include: {
      items: {
        include: {
          productVariant: {
            select: {
              id: true,
              productId: true,
              attributes: true,
              salePrice: true,
              product: { select: { name: true, weightGrams: true } },
            },
          },
        },
      },
    },
  });
  if (combos.length === 0) return [];
  const siblings = await loadFlexibleComboVariants(workspaceId, combos);

  const variantIds = [
    ...new Set([...combos.flatMap((c) => c.items.map((i) => i.productVariantId)), ...siblings.map((v) => v.productVariantId)]),
  ];
  // The per-variant figures are wanted anyway — a seller looking at "none
  // left" needs to see WHICH component is the bottleneck — so the buildable
  // count is worked out from the same read rather than by calling
  // comboStockMap, which would aggregate the same five tables a second time.
  const stock = await variantStockMap(workspaceId, variantIds);

  return combos.map((c) => {
    const components = withProductVariants(c.items.map((i) => ({
      productVariantId: i.productVariantId,
      productId: i.productVariant.productId,
      productName: i.productVariant.product.name,
      label: variantFullName(i.productVariant.product.name, i.productVariant.attributes),
      quantity: i.quantity,
      salePrice: i.productVariant.salePrice != null ? Number(i.productVariant.salePrice) : null,
      weightGrams: i.productVariant.product.weightGrams,
    })), siblings, c.flexibleVariants);
    return {
      id: c.id,
      name: c.name,
      sku: c.sku,
      price: Number(c.price),
      freeDelivery: c.freeDelivery,
      flexibleVariants: c.flexibleVariants,
      buildable: recipeBuildable(components, stock, c.flexibleVariants),
      listTotal: componentsTotal(components),
      components: components.map((c) => ({ ...c, stock: stock.get(c.productVariantId) ?? 0 })),
      allocation: c.flexibleVariants
        ? allocateFlexiblePrice(components, Number(c.price))
        : allocateComboPrice(components, Number(c.price), 1),
    };
  });
}

/**
 * What the storefront says this combo is, next to what this one says.
 *
 * Combos are built by hand in WooCommerce and again here, so the two WILL
 * drift — a price corrected on one side, a component added on the other — and
 * nothing else in the system would ever notice. This comparison is
 * deliberately shallow: the price, how many component lines, and how many
 * pieces in total. Matching component for component would need a Woo product
 * id typed onto every variant in the catalogue, which is a great many
 * hand-entered ids to catch mistakes these three numbers already catch.
 *
 * Never throws and never blocks. An unreachable storefront returns
 * `checked: false`, because a combo that cannot be verified must still be
 * sellable over the phone.
 */
export type ComboDrift = {
  checked: boolean;
  matches: boolean;
  /** One sentence naming what differs; null when it agrees or wasn't checked. */
  message: string | null;
};

export async function checkComboDrift(slug: string, id: string): Promise<ComboDrift> {
  const unchecked: ComboDrift = { checked: false, matches: true, message: null };
  const gate = await requireAccess(slug, "products", "view");
  if (!gate.ok) return unchecked;

  const combo = await prisma.comboSet.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    include: { items: { select: { productVariantId: true, quantity: true, productVariant: { select: { productId: true, wooProductId: true, product: { select: { name: true } } } } } } },
  });
  if (!combo?.wooProductId) return unchecked;

  const base = (process.env.WP_URL || "https://wp.gedushop.com").replace(/\/$/, "");
  let remote: {
    prices?: { price?: string; currency_minor_unit?: number };
    extensions?: { gedushop?: { combo?: { flexible_variants?: boolean; items?: { id?: number; qty?: number }[] } } };
  } | null = null;
  try {
    const res = await fetch(`${base}/wp-json/wc/store/v1/products/${combo.wooProductId}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return unchecked;
    remote = await res.json();
  } catch {
    return unchecked;
  }

  const wooCombo = remote?.extensions?.gedushop?.combo;
  if (!wooCombo?.items) {
    return {
      checked: true,
      matches: false,
      message: `Website product #${combo.wooProductId} is not marked as a combo there.`,
    };
  }

  const minor = remote?.prices?.currency_minor_unit ?? 2;
  const wooPrice = round2(Number(remote?.prices?.price ?? 0) / 10 ** minor);
  const localPrice = round2(Number(combo.price));
  const wooLines = wooCombo.items.length;
  const wooPieces = wooCombo.items.reduce((s, i) => s + (i.qty ?? 0), 0);
  const siblings = await loadFlexibleComboVariants(gate.access.workspaceId, [combo]);
  let localRecipe: { id: number; qty: number }[];
  try {
    localRecipe = comboWebsiteRecipe(combo.items.map((i) => ({
      productVariantId: i.productVariantId, productId: i.productVariant.productId,
      productName: i.productVariant.product.name, quantity: i.quantity,
      wooProductId: i.productVariant.wooProductId,
    })), siblings, combo.flexibleVariants);
  } catch (error) {
    return { checked: true, matches: false, message: error instanceof Error ? error.message : "Website links differ" };
  }
  const localLines = localRecipe.length;
  const localPieces = combo.items.reduce((s, i) => s + i.quantity, 0);

  const problems: string[] = [];
  if (Boolean(wooCombo.flexible_variants) !== combo.flexibleVariants) problems.push("variant mode differs");
  if (localRecipe.some((i) => !wooCombo.items!.some((r) => r.id === i.id && r.qty === i.qty))) problems.push("component products or quantities differ");
  if (wooPrice !== localPrice) {
    problems.push(`price ${wooPrice} there vs ${localPrice} here`);
  }
  if (wooLines !== localLines) {
    problems.push(`${wooLines} products there vs ${localLines} here`);
  }
  if (wooPieces !== localPieces) {
    problems.push(`${wooPieces} pieces there vs ${localPieces} here`);
  }

  return problems.length
    ? { checked: true, matches: false, message: `Website combo differs — ${problems.join("; ")}.` }
    : { checked: true, matches: true, message: null };
}
