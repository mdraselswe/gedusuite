"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import type { ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { variantFullName } from "@/lib/variants";
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
export type LinkResult = { ok: true } | ActionFailure;

/** The plugin on the website reads these two. They are the whole contract. */
const ITEMS_META = "_gedu_combo_items";
const FREE_SHIPPING_META = "_gedu_combo_free_shipping";

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
    select: { id: true, attributes: true, product: { select: { name: true } } },
  });
  if (!variant) return { ok: false, error: "Variant not found" };

  if (wooProductId !== null) {
    // Two variants pointing at one website product would make a combo's recipe
    // ask for the same shelf twice under two names, and the stock arithmetic
    // would quietly under-count what a set needs.
    const clash = await prisma.productVariant.findFirst({
      where: {
        wooProductId,
        id: { not: variantId },
        product: { workspaceId: gate.access.workspaceId },
      },
      select: { attributes: true, product: { select: { name: true } } },
    });
    if (clash) {
      return {
        ok: false,
        error: `Website product #${wooProductId} is already linked to ${variantFullName(clash.product.name, clash.attributes)}.`,
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
  return { ok: true };
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

  const unlinked = combo.items.filter((i) => !i.productVariant.wooProductId);
  if (unlinked.length > 0) {
    const names = unlinked
      .map((i) => variantFullName(i.productVariant.product.name, i.productVariant.attributes))
      .join(", ");
    return {
      ok: false,
      error: `Link ${unlinked.length > 1 ? "these products" : "this product"} to the website first: ${names}.`,
    };
  }

  const payload: Record<string, unknown> = {
    name: combo.name,
    type: "simple",
    regular_price: String(combo.price),
    // The website counts the combo's own stock, written by the plugin from the
    // components. Without this the shop would treat it as always available and
    // the last set would keep selling after the shelf was empty.
    manage_stock: true,
    meta_data: [
      {
        key: ITEMS_META,
        value: combo.items.map((i) => ({
          id: i.productVariant.wooProductId,
          qty: i.quantity,
        })),
      },
      { key: FREE_SHIPPING_META, value: combo.freeDelivery ? "yes" : "no" },
    ],
  };
  if (combo.sku) payload.sku = combo.sku;

  let created = false;
  let result: WooProductResponse;
  try {
    if (combo.wooProductId) {
      result = await wooFetch<WooProductResponse>(`/products/${combo.wooProductId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
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
