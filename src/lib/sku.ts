/**
 * SKUs in this catalogue follow PREFIX-SUB-NNN — "EDU-BRD-082".
 *
 *   PREFIX  what family of thing it is (TOY, FED, CARE, EDU, GEAR, ACC, PARTY)
 *   SUB     the specific type (BRD a board, PZL a puzzle, TTH a teether…)
 *   NNN     a running number across the WHOLE catalogue, not per prefix
 *
 * The vocabulary is deliberately read back out of the existing products rather
 * than hard-coded: a code invented today is offered as a choice tomorrow, and
 * nothing here goes stale when the shop's range changes.
 *
 * Only the number is decidable from data. Which SUB fits is a judgement about
 * how the thing works — a peg puzzle whose name ends in "Board" is PZL, not
 * BRD — so the builder suggests and the person chooses.
 */

export type SkuParts = { prefix: string; sub: string; n: number };

const SKU_RE = /^([A-Z]+)-([A-Z]+)-(\d+)$/;

export function parseSku(sku: string | null | undefined): SkuParts | null {
  const m = SKU_RE.exec((sku ?? "").trim().toUpperCase());
  return m ? { prefix: m[1], sub: m[2], n: Number(m[3]) } : null;
}

export function formatSku(prefix: string, sub: string, n: number): string {
  return `${prefix.toUpperCase()}-${sub.toUpperCase()}-${String(n).padStart(3, "0")}`;
}

type SkuSource = { sku: string | null; category: string | null };

/** Next free number: highest in use + 1, so gaps are never reused. */
export function nextSkuNumber(products: SkuSource[]): number {
  let max = 0;
  for (const p of products) {
    const parsed = parseSku(p.sku);
    if (parsed && parsed.n > max) max = parsed.n;
  }
  return max + 1;
}

/** Every prefix in use, most-used first. */
export function knownPrefixes(products: SkuSource[]): { code: string; count: number }[] {
  return tally(products.map((p) => parseSku(p.sku)?.prefix));
}

/** The SUB codes seen under one prefix, most-used first. */
export function subCodesFor(products: SkuSource[], prefix: string): { code: string; count: number }[] {
  return tally(
    products.map((p) => {
      const parsed = parseSku(p.sku);
      return parsed?.prefix === prefix.toUpperCase() ? parsed.sub : undefined;
    }),
  );
}

/**
 * The prefix this category's products actually use most. A guess, not a rule —
 * Nursery & Bedding genuinely holds CARE, TOY and GEAR items, and the person
 * adding a cot mobile knows which one it is better than any lookup table.
 */
export function suggestPrefix(products: SkuSource[], category: string): string | null {
  if (!category) return null;
  const inCategory = products.filter((p) => p.category === category);
  return knownPrefixes(inCategory)[0]?.code ?? null;
}

/** Case-insensitive, because the DB has no unique index to lean on. */
export function isSkuTaken(products: SkuSource[], sku: string, exceptSku?: string | null): boolean {
  const want = sku.trim().toUpperCase();
  if (!want) return false;
  if (exceptSku && exceptSku.trim().toUpperCase() === want) return false;
  return products.some((p) => (p.sku ?? "").trim().toUpperCase() === want);
}

function tally(values: (string | undefined)[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
