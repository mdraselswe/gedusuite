/**
 * The partner-ledger-specific pieces of its filter bar. The generic filtering
 * lives in filter-bar.tsx; what's here is the vocabulary only this list has.
 */

/** Rows nobody generated. A real answer, not "no source selected". */
export const MANUAL = "__manual__";

export const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: MANUAL, label: "Hand-entered" },
  { value: "purchase", label: "From product purchase" },
  { value: "internalPurchase", label: "From internal purchase" },
  { value: "boost", label: "From boosting" },
  { value: "distribution", label: "From distribution" },
];

/** Sum per type — investments and withdrawals added together mean nothing. */
export function totalsByType(rows: { type: string; amount: number }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const t of rows) {
    const next = (totals.get(t.type) ?? 0) + t.amount;
    totals.set(t.type, Math.round((next + Number.EPSILON) * 100) / 100);
  }
  return totals;
}
