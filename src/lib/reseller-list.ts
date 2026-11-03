import { prisma } from "@/lib/prisma";
import { variantCost, variantListPrice } from "@/lib/inventory";
import { variantValues } from "@/lib/variants";
import {
  compareResellerRows,
  parseBands,
  parseOverrides,
  parseTiers,
  priceVariant,
  resellerRow,
  tierLabel,
  tiersForBands,
  type PricedVariant,
  type PricingSettings,
  type ResellerRow,
} from "@/lib/reseller-pricing";

/**
 * Everything the reseller price list is built from, loaded once and handed to
 * the shop's page, the Google Sheet and the PDF alike — so all three can only
 * ever disagree about which columns they show, never about a price.
 */

export type ResellerListSettings = PricingSettings & {
  title: string;
  notes: string;
};

export type InternalRow = {
  variantId: string;
  productId: string;
  product: string;
  variant: string;
  sku: string | null;
  category: string | null;
  hidden: boolean;
  /** No retail price anywhere: nothing to discount from, so not on the list. */
  unpriced: boolean;
  overrides: Record<number, number>;
  /** Its own bands (the quantity each starts at), or null for the list's. */
  customBands: number[] | null;
  priced: PricedVariant | null;
  /** Each band's price with nothing set by hand — what clearing an override gives. */
  autoPrices: number[] | null;
};

export async function loadResellerSettings(workspaceId: string): Promise<ResellerListSettings> {
  const list = await prisma.resellerPriceList.findUnique({ where: { workspaceId } });
  return {
    title: list?.title ?? "Reseller price list",
    notes: list?.notes ?? "",
    tiers: parseTiers(list?.tiers),
    minMarginPct: list ? Number(list.minMarginPct) : 10,
    roundTo: list?.roundTo ?? 5,
  };
}

export async function loadResellerList(workspaceId: string): Promise<{
  settings: ResellerListSettings;
  rows: InternalRow[];
  /** What leaves the app, sorted — hidden and unpriced variants already gone. */
  resellerRows: ResellerRow[];
  /** The list's own bands; a variant with bands of its own has other labels. */
  tierLabels: string[];
}> {
  const [settings, variants] = await Promise.all([
    loadResellerSettings(workspaceId),
    prisma.productVariant.findMany({
      where: { product: { workspaceId } },
      select: {
        id: true,
        productId: true,
        attributes: true,
        sku: true,
        salePrice: true,
        unitCost: true,
        product: { select: { name: true, category: true, sku: true } },
        purchases: {
          where: { workspaceId },
          orderBy: { date: "desc" },
          select: { unitCost: true, quantity: true, salePrice: true },
        },
        resellerPrice: { select: { hidden: true, prices: true, bands: true } },
      },
    }),
  ]);

  const rows: InternalRow[] = variants.map((v) => {
    const retail = variantListPrice(v);
    const overrides = parseOverrides(v.resellerPrice?.prices);
    const cost = v.purchases.length > 0 || v.unitCost != null ? variantCost(v) : null;
    const customBands = parseBands(v.resellerPrice?.bands);
    const own = { ...settings, tiers: tiersForBands(settings.tiers, customBands) };
    return {
      variantId: v.id,
      productId: v.productId,
      product: v.product.name,
      variant: variantValues(v.attributes),
      sku: v.sku ?? v.product.sku,
      category: v.product.category,
      hidden: v.resellerPrice?.hidden ?? false,
      unpriced: retail == null,
      overrides,
      customBands,
      priced: retail == null ? null : priceVariant({ cost, retail, overrides }, own),
      autoPrices: retail == null ? null : priceVariant({ cost, retail }, own).tiers.map((t) => t.price),
    };
  });

  rows.sort(
    (a, b) =>
      // Uncategorised last, as on the sheet.
      Number(!a.category) - Number(!b.category) ||
      (a.category ?? "").localeCompare(b.category ?? "") ||
      a.product.localeCompare(b.product) ||
      a.variant.localeCompare(b.variant),
  );

  const resellerRows = rows
    .filter((r) => !r.hidden && r.priced)
    .map((r) =>
      resellerRow(
        { key: r.variantId, product: r.product, variant: r.variant, sku: r.sku, category: r.category },
        r.priced!,
      ),
    )
    .sort(compareResellerRows);

  return {
    settings,
    rows,
    resellerRows,
    tierLabels: settings.tiers.map((_, i) => tierLabel(settings.tiers, i)),
  };
}
