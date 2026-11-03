import { round2 } from "@/lib/money";

/**
 * Reseller prices, worked out from the shop's own figures.
 *
 * Two views come out of one calculation and must never be confused: the shop's
 * (cost, profit, margin — everything) and the reseller's (the prices on offer
 * and the retail price they agree not to undercut). Only `resellerRow` may
 * feed anything that leaves the app, so cost cannot leak by a careless column.
 */

export type ResellerTier = { minQty: number; discountPct: number };

export const DEFAULT_TIERS: ResellerTier[] = [
  { minQty: 1, discountPct: 10 },
  { minQty: 5, discountPct: 15 },
  { minQty: 10, discountPct: 20 },
];

/**
 * Read stored tiers into a clean ascending list whose first band starts at 1.
 * A list that can't be read falls back to the defaults rather than to no
 * prices at all.
 */
export function parseTiers(raw: unknown): ResellerTier[] {
  if (!Array.isArray(raw)) return DEFAULT_TIERS;
  const seen = new Set<number>();
  const tiers: ResellerTier[] = [];
  for (const t of raw) {
    const minQty = Math.floor(Number((t as ResellerTier)?.minQty));
    const discountPct = Number((t as ResellerTier)?.discountPct);
    if (!Number.isFinite(minQty) || minQty < 1 || seen.has(minQty)) continue;
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 100) continue;
    seen.add(minQty);
    tiers.push({ minQty, discountPct });
  }
  if (tiers.length === 0) return DEFAULT_TIERS;
  tiers.sort((a, b) => a.minQty - b.minQty);
  // The single-piece price is the promise made to every reseller; there is
  // always one.
  if (tiers[0].minQty !== 1) tiers.unshift({ minQty: 1, discountPct: 0 });
  return tiers;
}

/** "1–4 pcs", "5–9 pcs", "10+ pcs". */
export function tierLabel(tiers: ResellerTier[], i: number): string {
  const from = tiers[i].minQty;
  const next = tiers[i + 1]?.minQty;
  if (next == null) return `${from}+ pcs`;
  if (next - 1 === from) return `${from} pc${from === 1 ? "" : "s"}`;
  return `${from}–${next - 1} pcs`;
}

export const MAX_BANDS = 8;

/**
 * A variant's own bands, as the quantity each starts at. Null when it has none
 * of its own (or none that can be read) and follows the list's bands.
 */
export function parseBands(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const qtys = [...new Set(raw.map((q) => Math.floor(Number(q))).filter((q) => Number.isFinite(q) && q >= 1))];
  if (qtys.length === 0) return null;
  qtys.sort((a, b) => a - b);
  if (qtys[0] !== 1) qtys.unshift(1);
  return qtys.slice(0, MAX_BANDS);
}

/**
 * A variant's own bands as tiers. Each takes the discount of the list's band
 * its first quantity falls in, so a calculated price stays in line with the
 * rest of the list; a hand-set price replaces it anyway.
 */
export function tiersForBands(listTiers: ResellerTier[], bands: number[] | null): ResellerTier[] {
  if (!bands) return listTiers;
  return bands.map((minQty) => {
    let discountPct = 0;
    for (const t of listTiers) if (t.minQty <= minQty) discountPct = t.discountPct;
    return { minQty, discountPct };
  });
}

/** Hand-set prices by band, keyed by minQty. Unreadable entries are dropped. */
export function parseOverrides(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const q = Number(k);
    const p = Number(v);
    if (Number.isInteger(q) && q >= 1 && v !== null && v !== "" && Number.isFinite(p) && p >= 0) {
      out[q] = round2(p);
    }
  }
  return out;
}

/** Round up to a multiple of `step` — rounding a price down would eat margin. */
export function roundUpTo(value: number, step: number): number {
  if (!(step > 0)) return round2(value);
  // Settle to paisa first, so float noise (1000 × 0.85 = 850.0000000001)
  // doesn't push a price up a whole step.
  return round2(Math.ceil(round2(value) / step - 1e-9) * step);
}

export type TierPrice = {
  minQty: number;
  label: string;
  price: number;
  /** Hand-set for this variant rather than calculated. */
  manual: boolean;
  /** The discount would have gone below the minimum margin; raised to it. */
  raisedToFloor: boolean;
  /** Profit per piece at this price, against cost. Null when cost is unknown. */
  profit: number | null;
  /** Profit as a percent of cost. Null when cost is unknown or zero. */
  marginPct: number | null;
  /** What the reseller keeps per piece selling at the retail price. */
  resellerGain: number;
  /** A hand-set price under the minimum margin, or under cost. */
  belowFloor: boolean;
};

export type PricedVariant = {
  cost: number | null;
  retail: number;
  floor: number | null;
  tiers: TierPrice[];
  /** A bigger band costs more per piece than a smaller one — almost always a typo. */
  bandsOutOfOrder: boolean;
};

export type PricingSettings = {
  tiers: ResellerTier[];
  minMarginPct: number;
  roundTo: number;
};

/**
 * Price one variant for every band.
 *
 * A calculated price is the retail price less the band's discount, rounded up,
 * and never below cost plus the minimum margin. A hand-set price is taken as
 * given — the owner may have a reason — but flagged when it is under that
 * floor, so a slip of the finger shows up red instead of in the sheet.
 *
 * `cost` null means nobody has ever recorded one: prices are still calculated
 * from retail, there is just no floor to hold them to.
 */
export function priceVariant(
  input: { cost: number | null; retail: number; overrides?: Record<number, number> },
  settings: PricingSettings,
): PricedVariant {
  const { retail } = input;
  const cost = input.cost != null && input.cost > 0 ? input.cost : null;
  const overrides = input.overrides ?? {};
  const floor = cost != null ? round2(cost * (1 + settings.minMarginPct / 100)) : null;

  const tiers = settings.tiers.map((t, i): TierPrice => {
    const manualPrice = overrides[t.minQty];
    let price: number;
    let raisedToFloor = false;
    if (manualPrice != null) {
      price = manualPrice;
    } else {
      price = roundUpTo(retail * (1 - t.discountPct / 100), settings.roundTo);
      // Rounding up can overshoot retail on a cheap item with a small
      // discount; a reseller price above the shop's own is no offer at all.
      if (price > retail) price = round2(retail);
      if (floor != null && price < floor) {
        price = Math.min(roundUpTo(floor, settings.roundTo), Math.max(retail, floor));
        raisedToFloor = true;
      }
    }
    const profit = cost != null ? round2(price - cost) : null;
    return {
      minQty: t.minQty,
      label: tierLabel(settings.tiers, i),
      price,
      manual: manualPrice != null,
      raisedToFloor,
      profit,
      marginPct: cost != null ? round2(((price - cost) / cost) * 100) : null,
      resellerGain: round2(retail - price),
      belowFloor: manualPrice != null && floor != null && price < floor,
    };
  });

  const bandsOutOfOrder = tiers.some((t, i) => i > 0 && t.price > tiers[i - 1].price);
  return { cost, retail, floor, tiers, bandsOutOfOrder };
}

/**
 * The only shape that leaves the app: what a reseller is offered. No cost, no
 * profit, no margin — by construction rather than by remembering to hide them.
 */
export type ResellerRow = {
  key: string;
  product: string;
  variant: string;
  sku: string;
  category: string;
  retail: number;
  /** This row's own bands — they can differ from one product to the next. */
  bands: { label: string; price: number }[];
};

/** "1 pc: ৳900" lines, the way a sheet cell and the PDF show a row's bands. */
export function bandLines(row: ResellerRow, money: (v: number) => string): string[] {
  return row.bands.map((b) => `${b.label}: ${money(b.price)}`);
}

export function resellerRow(
  base: { key: string; product: string; variant: string; sku: string | null; category: string | null },
  priced: PricedVariant,
): ResellerRow {
  return {
    key: base.key,
    product: base.product,
    variant: base.variant,
    sku: base.sku ?? "",
    category: base.category ?? "",
    retail: priced.retail,
    bands: priced.tiers.map((t) => ({ label: t.label, price: t.price })),
  };
}

/** Sheet and PDF order: category, then product, then variant. Uncategorised last. */
export function compareResellerRows(a: ResellerRow, b: ResellerRow): number {
  if (!a.category !== !b.category) return a.category ? -1 : 1;
  return (
    a.category.localeCompare(b.category) ||
    a.product.localeCompare(b.product) ||
    a.variant.localeCompare(b.variant)
  );
}
