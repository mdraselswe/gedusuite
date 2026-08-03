/**
 * A call-list lead stores what was ordered as one plain string — deliberately,
 * since it is there to be read on the phone, not to move stock (see OrderLead
 * in schema.prisma). WooCommerce writes it as "Name (variation) x2, Other x1"
 * and anything typed by hand has to match, or the same order would read two
 * different ways depending on where it came from.
 *
 * So the composing and the splitting both live here, next to each other.
 */

export type LeadItem = { name: string; qty: number };

/** "Robotic Aeroplane (Blue) x2, Battery x3" — the WooCommerce shape. */
export function formatLeadItems(items: LeadItem[]): string {
  return items
    .map((i) => ({ name: i.name.trim(), qty: Math.max(1, Math.trunc(i.qty) || 1) }))
    .filter((i) => i.name)
    .map((i) => `${i.name} x${i.qty}`)
    .join(", ");
}

/**
 * Back into one line per item, for display.
 *
 * Only splits on a comma that directly follows a quantity marker: product
 * names contain commas of their own ("Baby Care Kit, 10pc") and splitting on
 * every comma would tear them in half.
 */
export function splitLeadItems(text: string): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<= x\d+),\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "Battery x3" -> { name: "Battery", qty: 3 }; no marker means one of it. */
export function parseLeadItem(entry: string): LeadItem {
  const m = /^(.*)\sx(\d+)$/.exec(entry.trim());
  return m ? { name: m[1].trim(), qty: Number(m[2]) } : { name: entry.trim(), qty: 1 };
}
