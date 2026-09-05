import { comboBuildable, componentsTotal, mergeByWebsiteProduct, type ComboComponent, type StockDemand } from "@/lib/combos";
import { round2 } from "@/lib/money";

export type RecipeComponent = ComboComponent & { productId: string };
export type ComboRecipe = { id: string; flexibleVariants: boolean; components: RecipeComponent[] };
export type ComboPick = { comboSetId: string; quantity: number; allocation?: StockDemand[] };

/** Recipe quantities define product totals; sibling variants are alternatives,
 * so adding a colour (now or later) must never add pieces to the offer. */
export function withProductVariants<T extends RecipeComponent, U extends RecipeComponent>(
  components: T[], candidates: U[], flexible: boolean,
): (T | U)[] {
  if (!flexible) return components;
  const products = new Set(components.map((c) => c.productId));
  const seen = new Set(components.map((c) => c.productVariantId));
  const result: (T | U)[] = [...components];
  for (const candidate of candidates) {
    if (!products.has(candidate.productId) || seen.has(candidate.productVariantId)) continue;
    seen.add(candidate.productVariantId);
    result.push({ ...candidate, quantity: 0 });
  }
  return result;
}

/** A mixed product has one shared website listing. Unlinked new colours inherit
 * that listing for the recipe only; variant link records are never rewritten. */
export function comboWebsiteRecipe(
  components: { productVariantId: string; productId: string; productName: string; quantity: number; wooProductId: number | null }[],
  candidates: { productId: string; wooProductId: number | null }[],
  flexible: boolean,
) {
  const recipe = components.map((c) => {
    if (!flexible) {
      if (c.wooProductId == null) throw new Error(`Link ${c.productName} to the website first.`);
      return { wooProductId: c.wooProductId, quantity: c.quantity };
    }
    const links = new Set([...components, ...candidates]
      .filter((v) => v.productId === c.productId && v.wooProductId != null)
      .map((v) => v.wooProductId!));
    if (links.size === 0) throw new Error(`Link one variant of ${c.productName} to its shared website listing first.`);
    if (links.size > 1) throw new Error(`Variants of ${c.productName} link to different website products. A flexible combo needs one shared listing for this product.`);
    return { wooProductId: [...links][0], quantity: c.quantity };
  });
  return mergeByWebsiteProduct(recipe);
}

/** Shared pools may overlap: A accepts yellow/blue and B accepts yellow only.
 * Residual edges let B reclaim yellow and move A to blue instead of falsely
 * reporting a shortage. Capacities are pieces, so even bulk orders stay small. */
function allocatePools(demands: { pick: number; components: RecipeComponent[]; quantity: number }[], stock: Map<string, number>) {
  type Edge = { to: number; capacity: number; reverse: number };
  const ids = [...new Set(demands.flatMap((d) => d.components.map((c) => c.productVariantId)))].sort((a, b) => (stock.get(b) ?? 0) - (stock.get(a) ?? 0) || a.localeCompare(b));
  const sink = 1 + ids.length + demands.length;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (from: number, to: number, capacity: number) => {
    const edge: Edge = { to, capacity, reverse: graph[to].length };
    graph[from].push(edge);
    graph[to].push({ to: from, capacity: 0, reverse: graph[from].length - 1 });
    return edge;
  };
  ids.forEach((id, i) => add(0, i + 1, Math.max(0, stock.get(id) ?? 0)));
  const links: { pick: number; id: string; edge: Edge }[] = [];
  let need = 0;
  demands.forEach((d, i) => {
    const node = 1 + ids.length + i;
    need += d.quantity;
    add(node, sink, d.quantity);
    ids.forEach((id, j) => {
      if (d.components.some((c) => c.productVariantId === id)) links.push({ pick: d.pick, id, edge: add(j + 1, node, d.quantity) });
    });
  });
  let sent = 0;
  while (sent < need) {
    const parent = new Map<number, { node: number; edge: Edge }>();
    const queue = [0];
    const seen = new Set([0]);
    for (let i = 0; i < queue.length && !seen.has(sink); i++) {
      for (const edge of graph[queue[i]]) {
        if (edge.capacity <= 0 || seen.has(edge.to)) continue;
        seen.add(edge.to);
        parent.set(edge.to, { node: queue[i], edge });
        queue.push(edge.to);
      }
    }
    if (!seen.has(sink)) throw new Error("Not enough stock for the flexible combo after other items and gifts");
    let amount = need - sent;
    for (let n = sink; n !== 0;) {
      const p = parent.get(n)!;
      amount = Math.min(amount, p.edge.capacity);
      n = p.node;
    }
    for (let n = sink; n !== 0;) {
      const p = parent.get(n)!;
      p.edge.capacity -= amount;
      graph[n][p.edge.reverse].capacity += amount;
      n = p.node;
    }
    sent += amount;
  }
  const allocations = new Map<number, Map<string, number>>();
  for (const { pick, id, edge } of links) {
    const quantity = graph[edge.to][edge.reverse].capacity;
    const allocation = allocations.get(pick) ?? new Map<string, number>();
    allocation.set(id, (allocation.get(id) ?? 0) + quantity);
    allocations.set(pick, allocation);
  }
  return allocations;
}

export function recipeGroups(components: RecipeComponent[]) {
  const groups = new Map<string, RecipeComponent[]>();
  for (const c of components) groups.set(c.productId, [...(groups.get(c.productId) ?? []), c]);
  return [...groups.values()];
}

export function recipeBuildable(components: RecipeComponent[], stock: Map<string, number>, flexible: boolean) {
  if (!flexible) return comboBuildable(components, stock);
  if (!components.length) return 0;
  return Math.min(...recipeGroups(components).map((group) => {
    const need = group.reduce((n, c) => n + c.quantity, 0);
    const have = group.reduce((n, c) => n + Math.max(0, stock.get(c.productVariantId) ?? 0), 0);
    return need > 0 ? Math.floor(have / need) : 0;
  }));
}

/** Allocate the whole basket, reserving exact choices before flexible ones.
 * A pick's allocation is for all its sets together. Each returned array is one set,
 * preserving the existing invoice grouping and partial-return records.
 * The input stock map is never mutated. The save transaction rechecks actual demand.
 */
export function resolveComboPicks(recipes: ComboRecipe[], picks: ComboPick[], stock: Map<string, number>, reserved: StockDemand[] = []): RecipeComponent[][][] {
  const remaining = new Map(stock);
  const byId = new Map(recipes.map((c) => [c.id, c]));
  const reserve = (lines: StockDemand[]) => {
    for (const c of lines) remaining.set(c.productVariantId, (remaining.get(c.productVariantId) ?? 0) - c.quantity);
  };
  reserve(reserved);
  for (const p of picks) {
    const recipe = byId.get(p.comboSetId);
    if (!recipe || !Number.isSafeInteger(p.quantity) || p.quantity <= 0) throw new Error("Invalid combo selection");
    if (!recipe.flexibleVariants) {
      if (p.allocation) throw new Error("Fixed combos cannot change variants");
      reserve(recipe.components.map((c) => ({ ...c, quantity: c.quantity * p.quantity })));
    } else if (p.allocation) {
      const seen = new Set<string>();
      for (const a of p.allocation) {
        if (!Number.isSafeInteger(a.quantity) || a.quantity < 0 || seen.has(a.productVariantId) || !recipe.components.some((c) => c.productVariantId === a.productVariantId)) {
          throw new Error("Choose variants of this combo's products, with whole quantities");
        }
        seen.add(a.productVariantId);
      }
      for (const group of recipeGroups(recipe.components)) {
        const need = group.reduce((n, c) => n + c.quantity, 0) * p.quantity;
        const actual = p.allocation.filter((a) => group.some((c) => c.productVariantId === a.productVariantId)).reduce((n, a) => n + a.quantity, 0);
        if (actual !== need) throw new Error(`Combo allocation must contain ${need} pieces of each required product`);
      }
      reserve(p.allocation);
    }
  }
  const demands = picks.flatMap((p, pick) => {
    const recipe = byId.get(p.comboSetId)!;
    return recipe.flexibleVariants && !p.allocation
      ? recipeGroups(recipe.components).map((components) => ({ pick, components, quantity: components.reduce((n, c) => n + c.quantity, 0) * p.quantity }))
      : [];
  });
  const automatic = allocatePools(demands, remaining);
  return picks.map((p, index) => {
    const recipe = byId.get(p.comboSetId)!;
    if (!recipe.flexibleVariants) return Array.from({ length: p.quantity }, () => recipe.components.map((c) => ({ ...c })));
    const chosen = p.allocation ? new Map(p.allocation.map((a) => [a.productVariantId, a.quantity])) : automatic.get(index) ?? new Map<string, number>();
    return Array.from({ length: p.quantity }, () => {
      const lines: RecipeComponent[] = [];
      for (const group of recipeGroups(recipe.components)) {
        let need = group.reduce((n, c) => n + c.quantity, 0);
        const candidates = [...group].sort((a, b) => (chosen.get(b.productVariantId) ?? 0) - (chosen.get(a.productVariantId) ?? 0) || a.productVariantId.localeCompare(b.productVariantId));
        for (const c of candidates) {
          const quantity = Math.min(need, Math.max(0, chosen.get(c.productVariantId) ?? 0));
          if (!quantity) continue;
          lines.push({ ...c, quantity });
          chosen.set(c.productVariantId, (chosen.get(c.productVariantId) ?? 0) - quantity);
          need -= quantity;
        }
        if (need) throw new Error("Not enough stock for the flexible combo after other items and gifts");
      }
      return lines;
    });
  });
}

/** A substituted variant must never change the promised combo price, even if
 * its catalogue price is missing or lower than the offer's per-piece price. */
export function allocateFlexiblePrice(components: ComboComponent[], price: number) {
  const pieces = components.reduce((n, c) => n + c.quantity, 0);
  if (!pieces) return [];
  const priced = componentsTotal(components) < price
    ? components.map((c) => ({ ...c, salePrice: Math.ceil(price * 100 / pieces) / 100 }))
    : components;
  const listTotal = componentsTotal(priced);
  const saving = round2(Math.max(0, listTotal - price));
  let cumulativeValue = 0;
  let assigned = 0;
  return priced.map((c, i) => {
    const unitPrice = c.salePrice ?? 0;
    cumulativeValue = round2(cumulativeValue + unitPrice * c.quantity);
    // Round cumulative shares, not each share separately: many tiny lines
    // must not consume the last line's discount or leave a zero-price row negative.
    const cumulativeDiscount = i === priced.length - 1
      ? saving
      : listTotal > 0 ? round2(saving * cumulativeValue / listTotal) : 0;
    const discount = round2(cumulativeDiscount - assigned);
    assigned = cumulativeDiscount;
    return { productVariantId: c.productVariantId, quantity: c.quantity, unitPrice, discount };
  });
}
