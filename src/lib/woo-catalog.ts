/**
 * Reading the website's catalogue, so a combo can be linked to it by name.
 *
 * A combo built here has to reach the website as a recipe, and a recipe is a
 * list of WooCommerce ids. Nobody should have to go and find those ids: this
 * fetches the catalogue once, flattens it — a variable product's variations
 * are what a combo actually contains, not the parent — and hands back a list
 * that can be searched by name in a picker.
 *
 * Deliberately read-only. Writing to the website lives in woo-push.ts, behind
 * a button somebody has to press.
 */

import { envWooConfig, hasWriteKeys, type WooConfig } from "@/lib/woo-config";

const CATALOGUE_TTL_MS = 5 * 60 * 1000;

export type WooCatalogEntry = {
  /** Product id for a simple product, variation id for one option of a variable one. */
  id: number;
  /** "Silicone Baby Feeding Bottle — Pink" — what somebody would search for. */
  label: string;
  sku: string | null;
  /** Set on a variation, so the picker can group under the parent. */
  parentId: number | null;
  /**
   * A component the website doesn't count is a component a combo can never run
   * out of. Worth showing in the picker rather than discovering later.
   */
  managesStock: boolean;
  stock: number | null;
};

type WooRestProduct = {
  id?: number;
  name?: string;
  sku?: string;
  type?: string;
  status?: string;
  manage_stock?: boolean;
  stock_quantity?: number | null;
};

type WooRestVariation = WooRestProduct & {
  attributes?: { option?: string }[];
};

/**
 * Whether write access to a website is available.
 *
 * `cfg` is the workspace's resolved connection (see lib/woo-config). Left out,
 * it means "whatever the environment says", which is what every caller did
 * before connections were per workspace.
 */
export function wooAdminConfigured(cfg?: WooConfig | null) {
  return hasWriteKeys(cfg === undefined ? envWooConfig() : cfg);
}

export function wooBase(cfg?: WooConfig | null) {
  return (cfg ?? envWooConfig()).base;
}

function authHeader(cfg: WooConfig) {
  return "Basic " + Buffer.from(`${cfg.writeKey}:${cfg.writeSecret}`).toString("base64");
}

/**
 * One WooCommerce REST call.
 *
 * `init` carries the method and body for writes; everything shares the auth
 * header, the no-store cache and the timeout, because a website that has gone
 * quiet should fail the button rather than hang the page.
 */
export async function wooFetch<T>(
  path: string,
  init?: RequestInit,
  cfg: WooConfig = envWooConfig(),
): Promise<T> {
  const res = await fetch(`${cfg.base}/wp-json/wc/v3${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body?.message ? ` — ${body.message}` : "";
    } catch {
      // A gateway error page isn't JSON. The status is enough.
    }
    throw new Error(`Website returned ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

// One cached catalogue per website, never shared between workspaces.
const cache = new Map<string, { at: number; entries: WooCatalogEntry[] }>();
const cacheKey = (cfg: WooConfig) => `${cfg.base}|${cfg.writeKey}`;

/**
 * Every sellable thing on the website, variations flattened in.
 *
 * Cached for a few minutes. This is a dozen HTTP calls against a live shop and
 * the answer only changes when somebody edits the catalogue; refetching it on
 * every keystroke of a search box would be rude to the website and slow here.
 */
export async function fetchWooCatalog(
  force = false,
  cfg: WooConfig | null = envWooConfig(),
): Promise<WooCatalogEntry[]> {
  if (!hasWriteKeys(cfg)) {
    throw new Error("Website connection is not configured");
  }
  const hit = cache.get(cacheKey(cfg));
  if (!force && hit && Date.now() - hit.at < CATALOGUE_TTL_MS) {
    return hit.entries;
  }

  const products: WooRestProduct[] = [];
  // Paged rather than one huge request: WooCommerce caps per_page at 100, and
  // a shop that grows past that shouldn't silently start losing its tail.
  for (let page = 1; page <= 20; page++) {
    const batch = await wooFetch<WooRestProduct[]>(
      `/products?per_page=100&page=${page}&status=publish&orderby=title&order=asc`,
      undefined,
      cfg,
    );
    products.push(...batch);
    if (batch.length < 100) break;
  }

  const entries: WooCatalogEntry[] = [];
  const variableIds: { id: number; name: string }[] = [];

  for (const p of products) {
    if (!p.id) continue;
    if (p.type === "variable") {
      variableIds.push({ id: p.id, name: p.name ?? `#${p.id}` });
      continue;
    }
    // A grouped or external product isn't a thing with stock, so it can't be a
    // combo component.
    if (p.type && p.type !== "simple") continue;
    entries.push({
      id: p.id,
      label: p.name ?? `#${p.id}`,
      sku: p.sku || null,
      parentId: null,
      managesStock: Boolean(p.manage_stock),
      stock: p.stock_quantity ?? null,
    });
  }

  for (const parent of variableIds) {
    const variations = await wooFetch<WooRestVariation[]>(
      `/products/${parent.id}/variations?per_page=100`,
      undefined,
      cfg,
    );
    for (const v of variations) {
      if (!v.id) continue;
      const options = (v.attributes ?? [])
        .map((a) => a.option)
        .filter((o): o is string => Boolean(o));
      entries.push({
        id: v.id,
        label: options.length ? `${parent.name} — ${options.join(" / ")}` : parent.name,
        sku: v.sku || null,
        parentId: parent.id,
        // A variation can inherit "manage stock" from its parent, in which case
        // its own flag is false and its own quantity is null. Treated as not
        // counted, which is what it behaves like: the parent's number is shared
        // across every option, so no single variation has a number of its own.
        managesStock: Boolean(v.manage_stock),
        stock: v.stock_quantity ?? null,
      });
    }
  }

  entries.sort((a, b) => a.label.localeCompare(b.label));
  cache.set(cacheKey(cfg), { at: Date.now(), entries });
  return entries;
}

/** Drops the cache, so the next read sees a product that was just created. */
export function clearWooCatalogCache(cfg?: WooConfig | null) {
  if (cfg) cache.delete(cacheKey(cfg));
  else cache.clear();
}

/** Loose match: case, spaces and punctuation are not what anybody means. */
function normalise(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function searchCatalog(entries: WooCatalogEntry[], query: string, limit = 20) {
  const q = normalise(query);
  if (!q) return entries.slice(0, limit);
  const terms = q.split(" ");
  return entries
    .filter((e) => {
      const hay = normalise(`${e.label} ${e.sku ?? ""}`);
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}

/**
 * The guess a person would make: same SKU, or failing that the same name.
 *
 * Only ever a suggestion. Auto-linking the wrong product would put the wrong
 * thing in a recipe and quietly sell the wrong stock, so this returns matches
 * for somebody to confirm rather than writing them.
 */
export function suggestMatch(
  entries: WooCatalogEntry[],
  variant: { sku: string | null; label: string },
): WooCatalogEntry | null {
  if (variant.sku) {
    const bySku = entries.find(
      (e) => e.sku && normalise(e.sku) === normalise(variant.sku as string),
    );
    if (bySku) return bySku;
  }
  const target = normalise(variant.label);
  const exact = entries.filter((e) => normalise(e.label) === target);
  // Two products with the same name is exactly the case where a guess is worse
  // than no guess.
  return exact.length === 1 ? exact[0] : null;
}
