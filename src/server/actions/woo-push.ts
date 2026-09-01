"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import type { ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { variantFullName } from "@/lib/variants";
import { round2 } from "@/lib/money";
import { comboPricePayload, mergeByWebsiteProduct } from "@/lib/combos";
import {
  clearWooCatalogCache,
  fetchWooCatalog,
  searchCatalog,
  suggestMatch,
  wooAdminConfigured,
  wooFetch,
  type WooCatalogEntry,
} from "@/lib/woo-catalog";

export type PushResult = { ok: true; wooProductId: number; created: boolean } | ActionFailure;
export type LinkResult = { ok: true; unlinkedSiblings: number } | ActionFailure;

/** The plugin on the website reads these three. They are the whole contract. */
const ITEMS_META = "_gedu_combo_items";
const FREE_SHIPPING_META = "_gedu_combo_free_shipping";
/**
 * What the combo sells for.
 *
 * Sent separately from WooCommerce's own price fields because those two say
 * how a price is *presented* — a regular price with a sale price under it
 * reads as a discount, one alone does not — and the website works that out
 * from what the contents come to. It can only do so while something still
 * says plainly what the set sells for.
 */
const PRICE_META = "_gedu_combo_price";

function notConfigured(): ActionFailure {
  return {
    ok: false,
    error:
      "Website connection is not set up. Add WP_URL, WC_WRITE_KEY and WC_WRITE_SECRET to this app's environment.",
  };
}

// ── Linking a variant to the website ─────────────────────────────────

export type WebsiteOption = {
  id: number;
  label: string;
  sku: string | null;
  managesStock: boolean;
  stock: number | null;
};

const toOption = (e: WooCatalogEntry): WebsiteOption => ({
  id: e.id,
  label: e.label,
  sku: e.sku,
  managesStock: e.managesStock,
  stock: e.stock,
});

/**
 * Search the website's catalogue by name, for the picker.
 *
 * Returns a plain failure rather than throwing when the website is unreachable:
 * a shop being down should grey out one field, not break the products page.
 */
export async function searchWebsiteProducts(
  slug: string,
  query: string,
): Promise<{ ok: true; options: WebsiteOption[] } | ActionFailure> {
  const gate = await requireAccess(slug, "products", "view");
  if (!gate.ok) return gate;
  if (!wooAdminConfigured()) return notConfigured();

  try {
    const entries = await fetchWooCatalog();
    return { ok: true, options: searchCatalog(entries, query).map(toOption) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach the website" };
  }
}

/** Sets (or with null, clears) the website id a variant stands for. */
export async function linkVariantToWebsite(
  slug: string,
  variantId: string,
  wooProductId: number | null,
): Promise<LinkResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, product: { workspaceId: gate.access.workspaceId } },
    select: { id: true, productId: true, attributes: true, product: { select: { name: true } } },
  });
  if (!variant) return { ok: false, error: "Variant not found" };

  if (wooProductId !== null) {
    // Variants of ONE product sharing a website product is the ordinary case,
    // not a mistake: this app tracks a toy's colours apart, the website sells
    // one listing for all of them. The recipe is merged by website id before
    // it is pushed, so the set's arithmetic comes out right — see
    // mergeByWebsiteProduct, which is what makes this allowed.
    //
    // Two DIFFERENT products on one website product stays refused. That has no
    // honest reading: it would silently pack one thing where another was
    // ordered, and take its stock from the wrong shelf.
    const clash = await prisma.productVariant.findFirst({
      where: {
        wooProductId,
        productId: { not: variant.productId },
        product: { workspaceId: gate.access.workspaceId },
      },
      select: { attributes: true, product: { select: { name: true } } },
    });
    if (clash) {
      return {
        ok: false,
        error:
          `Website product #${wooProductId} already stands for ${variantFullName(clash.product.name, clash.attributes)}, ` +
          `which is a different product. Two products cannot share one website listing.`,
      };
    }
  }

  await prisma.productVariant.update({
    where: { id: variantId },
    data: { wooProductId },
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "ProductVariant",
    entityId: variantId,
    entityLabel: variantFullName(variant.product.name, variant.attributes),
    summary: wooProductId ? `Linked to website product #${wooProductId}` : "Website link removed",
  });

  revalidatePath(`/${slug}/products`);
  // Offered, not done: the other colours usually belong on the same website
  // listing, but "usually" is not "always", so a person says so.
  const unlinkedSiblings =
    wooProductId === null
      ? 0
      : await prisma.productVariant.count({
          where: { productId: variant.productId, id: { not: variantId }, wooProductId: null },
        });
  return { ok: true, unlinkedSiblings };
}

/**
 * What the website probably calls each of these variants.
 *
 * Suggestions only — nothing is written. Linking the wrong product would put
 * the wrong thing in a recipe and sell stock nobody meant to sell, so a person
 * confirms each one.
 */
export async function suggestWebsiteLinks(
  slug: string,
  variantIds: string[],
): Promise<{ ok: true; matches: Record<string, WebsiteOption> } | ActionFailure> {
  const gate = await requireAccess(slug, "products", "view");
  if (!gate.ok) return gate;
  if (!wooAdminConfigured()) return notConfigured();
  if (variantIds.length === 0) return { ok: true, matches: {} };

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds }, product: { workspaceId: gate.access.workspaceId } },
    select: { id: true, sku: true, attributes: true, product: { select: { name: true } } },
  });

  let entries: WooCatalogEntry[];
  try {
    entries = await fetchWooCatalog();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach the website" };
  }

  const matches: Record<string, WebsiteOption> = {};
  for (const v of variants) {
    const hit = suggestMatch(entries, {
      sku: v.sku,
      label: variantFullName(v.product.name, v.attributes),
    });
    if (hit) matches[v.id] = toOption(hit);
  }
  return { ok: true, matches };
}

// ── Pushing a combo to the website ───────────────────────────────────

type WooProductResponse = { id?: number; status?: string; permalink?: string };

/**
 * Create or update this combo as a product on the website.
 *
 * The recipe goes across as meta the plugin reads; the website works out the
 * combo's stock from it and keeps working it out. Nothing about quantities is
 * sent, deliberately — a number pushed from here would be a second opinion
 * about stock, and the whole design rests on there being only one.
 *
 * A new product is created as a **draft**. This writes to a live shop: a wrong
 * price should be something somebody catches while reviewing, not something a
 * customer finds by paying it.
 */
export async function pushComboToWebsite(slug: string, comboId: string): Promise<PushResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;
  if (!wooAdminConfigured()) return notConfigured();

  const combo = await prisma.comboSet.findFirst({
    where: { id: comboId, workspaceId: gate.access.workspaceId },
    include: {
      items: {
        include: {
          productVariant: {
            select: { id: true, attributes: true, wooProductId: true, product: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!combo) return { ok: false, error: "Combo not found" };
  if (combo.items.length === 0) return { ok: false, error: "Add products to the combo first" };

  // One pass so the guard below and the recipe agree by construction: every
  // item is either reported as unlinked or carries a website id the types know
  // about, with no cast standing in for the check.
  const recipe: { wooProductId: number; quantity: number }[] = [];
  const unlinked: typeof combo.items = [];
  for (const i of combo.items) {
    const wooProductId = i.productVariant.wooProductId;
    if (wooProductId == null) unlinked.push(i);
    else recipe.push({ wooProductId, quantity: i.quantity });
  }
  if (unlinked.length > 0) {
    const names = unlinked
      .map((i) => variantFullName(i.productVariant.product.name, i.productVariant.attributes))
      .join(", ");
    return {
      ok: false,
      error: `Link ${unlinked.length > 1 ? "these products" : "this product"} to the website first: ${names}.`,
    };
  }

  const price = round2(Number(combo.price));
  const payload: Record<string, unknown> = {
    name: combo.name,
    type: "simple",
    // The website counts the combo's own stock, written by the plugin from the
    // components. Without this the shop would treat it as always available and
    // the last set would keep selling after the shelf was empty.
    manage_stock: true,
    meta_data: [
      {
        key: ITEMS_META,
        // Merged, because several variants here can be one product there. Two
        // rows naming one listing would let the website work out a larger
        // buildable count than the shelf can actually fill.
        value: mergeByWebsiteProduct(recipe),
      },
      { key: FREE_SHIPPING_META, value: combo.freeDelivery ? "yes" : "no" },
      { key: PRICE_META, value: String(price) },
    ],
  };
  if (combo.sku) payload.sku = combo.sku;

  let created = false;
  let result: WooProductResponse;
  try {
    if (combo.wooProductId) {
      // The website decides how the price is *presented* — it strikes the
      // contents' total through the selling price — so these two fields are
      // only a sane starting point for the moment before it does, and cover
      // the case where the plugin is missing or out of date. Reading the
      // existing regular price first keeps a compare-at price somebody set by
      // hand from being flattened in that case.
      const existing = await wooFetch<{ regular_price?: string }>(
        `/products/${combo.wooProductId}`,
      );
      Object.assign(payload, comboPricePayload(price, round2(Number(existing?.regular_price ?? 0))));
      result = await wooFetch<WooProductResponse>(`/products/${combo.wooProductId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      Object.assign(payload, comboPricePayload(price, 0));
      created = true;
      result = await wooFetch<WooProductResponse>("/products", {
        method: "POST",
        // Draft on purpose — see the note above.
        body: JSON.stringify({ ...payload, status: "draft", catalog_visibility: "visible" }),
      });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Push to website failed" };
  }

  const wooProductId = result?.id;
  if (!wooProductId) {
    return { ok: false, error: "The website did not return a product id" };
  }

  if (combo.wooProductId !== wooProductId) {
    await prisma.comboSet.update({
      where: { id: comboId },
      data: { wooProductId },
    });
  }
  // The new product would otherwise be invisible to the picker for five
  // minutes, which is exactly when somebody would go looking for it.
  clearWooCatalogCache();

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "ComboSet",
    entityId: comboId,
    entityLabel: combo.name,
    summary: created
      ? `Created on the website as draft product #${wooProductId}`
      : `Pushed to website product #${wooProductId}`,
  });

  revalidatePath(`/${slug}/products`);
  return { ok: true, wooProductId, created };
}

/**
 * Link every other variant of this product to the same website product.
 *
 * The website often sells as one listing what this app tracks as several
 * variants — a toy's colours, say, where the shop does not promise which one
 * goes in the box. Linking those one at a time is the same choice made five
 * times, so it is offered once after the first is made.
 *
 * Only variants with no link are touched: one already pointing somewhere else
 * was pointed there on purpose.
 */
export async function linkSiblingVariantsToWebsite(
  slug: string,
  variantId: string,
  wooProductId: number,
): Promise<{ ok: true; linked: number } | ActionFailure> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;

  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, product: { workspaceId: gate.access.workspaceId } },
    select: { productId: true, product: { select: { name: true } } },
  });
  if (!variant) return { ok: false, error: "Variant not found" };

  // The same rule the single link applies: one website listing may stand for
  // the variants of one product, never for two products.
  const clash = await prisma.productVariant.findFirst({
    where: {
      wooProductId,
      productId: { not: variant.productId },
      product: { workspaceId: gate.access.workspaceId },
    },
    select: { attributes: true, product: { select: { name: true } } },
  });
  if (clash) {
    return {
      ok: false,
      error: `Website product #${wooProductId} already stands for ${variantFullName(clash.product.name, clash.attributes)}, which is a different product.`,
    };
  }

  const { count } = await prisma.productVariant.updateMany({
    where: { productId: variant.productId, id: { not: variantId }, wooProductId: null },
    data: { wooProductId },
  });

  if (count > 0) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "Product",
      entityId: variant.productId,
      entityLabel: variant.product.name,
      summary: `Linked ${count} more ${count > 1 ? "variants" : "variant"} to website product #${wooProductId}`,
    });
    revalidatePath(`/${slug}/products`);
  }

  return { ok: true, linked: count };
}
