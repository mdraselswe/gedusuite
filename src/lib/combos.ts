/**
 * The arithmetic of selling several products as one priced set.
 *
 * A combo never reaches the database as a line of its own — it is expanded
 * into ordinary OrderItem rows when the order is saved (see createOrder), so
 * stock derivation, cost snapshots, returns and every profit report keep
 * working on rows they already understand. Two questions have to be answered
 * to do that, and both live here so the order form's preview and the server's
 * authoritative save can never disagree about the numbers on the invoice.
 */

import { round2 } from "@/lib/money";

/** One line of a combo recipe, priced at what the component normally sells for. */
export type ComboComponent = {
  productVariantId: string;
  /** Pieces of this variant in ONE set. */
  quantity: number;
  /** The variant's ordinary catalogue price per piece; null when it has none. */
  salePrice: number | null;
};

/** What one component contributes to one expanded order line. */
export type AllocatedComponent = {
  productVariantId: string;
  /** Pieces on this line = component quantity × how many sets were bought. */
  quantity: number;
  /** The ordinary catalogue price — NOT a share of the combo price. */
  unitPrice: number;
  /** This line's share of the combo saving, as a line-total discount. */
  discount: number;
};

/**
 * How many complete sets the components on hand can make.
 *
 * The whole of a combo's availability, and the reason nothing stores a combo
 * stock number anywhere: ask this instead. A recipe with no components can
 * make nothing — an empty `min()` is Infinity, which would have advertised an
 * unlimited supply of a set containing nothing.
 */
export function comboBuildable(
  components: { productVariantId: string; quantity: number }[],
  stock: Map<string, number>,
): number {
  if (components.length === 0) return 0;
  let buildable = Infinity;
  for (const c of components) {
    if (c.quantity <= 0) return 0;
    buildable = Math.min(buildable, Math.floor((stock.get(c.productVariantId) ?? 0) / c.quantity));
  }
  return Math.max(0, buildable);
}

/** What the same goods would have cost bought separately, for one set. */
export function componentsTotal(components: ComboComponent[]): number {
  return round2(components.reduce((s, c) => s + (c.salePrice ?? 0) * c.quantity, 0));
}

/**
 * Split a combo's price across its components, as discounts.
 *
 * The components keep their ordinary `unitPrice` and the saving is written
 * into each line's `discount`. Setting a reduced unit price instead would have
 * been simpler and lost two things worth keeping: `grossRevenue` would stop
 * meaning "what these goods list for", and — the real reason — a returned
 * piece would take none of the combo saving back with it. computeOrderTotals
 * already scales a line's discount by the fraction of it still kept, so
 * putting the saving there makes a partial return of a combo come out right
 * with no new code at all.
 *
 * The share is proportional to what each component is worth: the expensive
 * half of a set absorbs most of the discount, which is what makes a
 * single-line return of the cheap half refund a sensible figure. When no
 * component has a price on record — nothing to be proportional to — it falls
 * back to splitting by piece count.
 *
 * Rounding remainders land on the last line, so the discounts always sum to
 * exactly the saving. Anything else leaves an invoice one paisa off its own
 * total, every time, in a way nobody can find.
 */
export function allocateComboPrice(
  components: ComboComponent[],
  comboPrice: number,
  /** How many of this combo were bought. Every figure below scales with it. */
  sets = 1,
): AllocatedComponent[] {
  if (components.length === 0 || sets <= 0) return [];

  const lines = components.map((c) => ({
    productVariantId: c.productVariantId,
    quantity: c.quantity * sets,
    unitPrice: c.salePrice ?? 0,
    lineValue: (c.salePrice ?? 0) * c.quantity * sets,
  }));

  const listTotal = round2(lines.reduce((s, l) => s + l.lineValue, 0));
  const target = round2(comboPrice * sets);
  // A combo priced at or above what its parts list for is not a discount, and
  // the customer still pays the combo price — so the components carry no
  // saving and the difference simply is not one. Negative discounts would
  // report as negative revenue somewhere downstream.
  const saving = round2(Math.max(0, listTotal - target));

  // Nothing to be proportional to: no component has a price, so the list total
  // is zero and every share would be 0/0. Split by pieces instead.
  const weights = listTotal > 0
    ? lines.map((l) => l.lineValue / listTotal)
    : (() => {
        const pieces = lines.reduce((s, l) => s + l.quantity, 0);
        return pieces > 0 ? lines.map((l) => l.quantity / pieces) : lines.map(() => 0);
      })();

  let assigned = 0;
  return lines.map((l, i) => {
    const last = i === lines.length - 1;
    // The last line takes whatever is left rather than its own rounded share,
    // so the discounts sum to `saving` to the paisa.
    const discount = last ? round2(saving - assigned) : round2(saving * weights[i]);
    assigned = round2(assigned + discount);
    return {
      productVariantId: l.productVariantId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      // Guard the last line: a float path could leave it fractionally negative.
      discount: Math.max(0, discount),
    };
  });
}

/**
 * How a combo's price should be written to the website.
 *
 * What the combo sells for is decided in this app; how the website *presents*
 * that price is not. A shop that has put a higher regular price on the combo is
 * showing a crossed-out figure beside it, and overwriting the regular price
 * would delete that strike-through — the offer would still be the same money
 * and would stop looking like an offer at all.
 *
 * So the selling price goes across as a sale price whenever a higher regular
 * price is already standing, and replaces the regular price only when it is
 * not. `existingRegular` is 0 for a product being created.
 */
export function comboPricePayload(
  price: number,
  existingRegular: number,
): { regular_price?: string; sale_price: string } {
  if (existingRegular > price) {
    return { sale_price: String(price) };
  }
  // Clearing the sale price matters: a combo whose price rose above an old
  // sale price would otherwise keep selling at the old one.
  return { regular_price: String(price), sale_price: "" };
}

/**
 * A recipe rewritten in the website's ids, with repeats added together.
 *
 * Several variants here can be one product there: this app tracks a toy's
 * colours separately, the website sells one listing for all of them. That is a
 * deliberate choice — the shop does not promise a colour — and it means a
 * recipe of "Red ×1, Blue ×2" is, to the website, three of one product.
 *
 * Sending it unmerged is the bug this exists to prevent. The website works out
 * a combo's availability as the smallest `stock ÷ qty` across the rows, so two
 * rows naming one product with 10 in stock would answer min(10÷1, 10÷2) = 5
 * sets from stock that can only build 3 — and it would sell the difference.
 * Merged first, it answers 10÷3 = 3.
 *
 * Order is first-seen so the website lists the box's contents the way the
 * recipe was written.
 */
export function mergeByWebsiteProduct(
  items: { wooProductId: number; quantity: number }[],
): { id: number; qty: number }[] {
  const merged = new Map<number, number>();
  for (const i of items) {
    merged.set(i.wooProductId, (merged.get(i.wooProductId) ?? 0) + i.quantity);
  }
  return [...merged].map(([id, qty]) => ({ id, qty }));
}

/** One variant's claim on the shelf, whatever line it arrived on. */
export type StockDemand = { productVariantId: string; quantity: number };

/**
 * What an order asks for that the shelf cannot cover.
 *
 * One demand figure per variant, whatever it arrived as — a loose line, a
 * gift, or a piece inside a combo. This is the rule that makes a combo and a
 * single of the same product share one shelf: two combos each containing an
 * aeroplane, plus a third aeroplane on its own, is a demand of three and gets
 * checked as three.
 *
 * Checking each combo against its own buildable count instead answers a
 * different question — "could this set be built if it were the only thing on
 * the order" — and passes baskets that overdraw a shelf across several rows.
 *
 * A variant with no entry in `stock` counts as none. Absent is not unlimited:
 * the one place that mistake would surface is an order for something the shop
 * does not have.
 */
export function stockShortfall(
  demand: StockDemand[],
  stock: Map<string, number>,
): { productVariantId: string; need: number; have: number }[] {
  const need = new Map<string, number>();
  for (const d of demand) {
    if (d.quantity <= 0) continue;
    need.set(d.productVariantId, (need.get(d.productVariantId) ?? 0) + d.quantity);
  }
  return [...need]
    .map(([productVariantId, n]) => ({
      productVariantId,
      need: n,
      have: stock.get(productVariantId) ?? 0,
    }))
    .filter((r) => r.need > r.have);
}
