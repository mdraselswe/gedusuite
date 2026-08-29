/**
 * Reading a sold combo back off an order.
 *
 * A combo reaches the database as its components — that is what makes stock,
 * cost and returns work — so putting it back together for a person to read is
 * a display job, done here rather than in each of the three places that show
 * an order's lines.
 *
 * What comes out is deliberately net of the combo's own saving. On the order
 * those lines carry catalogue prices and a share of the discount each; on the
 * invoice the customer is owed the sentence they actually agreed to — one
 * combo, one price — and printing 900 + 650 with a 350 discount underneath is
 * the same arithmetic told the hard way. `comboDiscount` is returned so the
 * caller can keep its own "item discounts" line from counting that saving a
 * second time.
 */

import { round2 } from "@/lib/money";

/** The shape any order-lines query already has, plus the two combo tags. */
export type SoldLine = {
  id: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  comboSetId: string | null;
  comboKey: string | null;
  label: string;
  /** Pieces of this line that have come back. */
  returned: number;
};

export type ComboGroup = {
  kind: "combo";
  comboSetId: string;
  /** The recipe's name, or a fallback when the combo has since been deleted. */
  name: string;
  /** How many sets — one per distinct comboKey. */
  sets: number;
  lines: SoldLine[];
  /** Kept quantity × catalogue price, before the combo's saving. */
  gross: number;
  /** The saving, scaled to what was kept. */
  discount: number;
  /** What these sets actually come to. */
  net: number;
  /** Pieces returned across the whole set. */
  returned: number;
};

export type LooseGroup = { kind: "item"; line: SoldLine };

export type LineGroup = ComboGroup | LooseGroup;

/**
 * Group an order's lines, combos first, in the order they were entered.
 *
 * Grouped by combo rather than by set: two Flight Starter Combos read as
 * "Flight Starter Combo ×2", which is what was bought and what a customer
 * checks against. The set count comes from the distinct `comboKey`s, which is
 * the only thing that can tell two sets apart once their components have been
 * merged.
 *
 * A line tagged with a combo id but no key — which nothing writes, but a
 * hand-edited row could — is treated as loose rather than silently folded into
 * a set it may not belong to.
 */
export function groupComboLines(
  lines: SoldLine[],
  /** Recipe names by id. A deleted combo simply isn't in here. */
  names: Map<string, string>,
): { groups: LineGroup[]; comboDiscount: number } {
  const groups: LineGroup[] = [];
  const byCombo = new Map<string, ComboGroup>();
  const keysSeen = new Map<string, Set<string>>();

  for (const line of lines) {
    if (!line.comboSetId || !line.comboKey) {
      groups.push({ kind: "item", line });
      continue;
    }
    let group = byCombo.get(line.comboSetId);
    if (!group) {
      group = {
        kind: "combo",
        comboSetId: line.comboSetId,
        name: names.get(line.comboSetId) ?? "Combo",
        sets: 0,
        lines: [],
        gross: 0,
        discount: 0,
        net: 0,
        returned: 0,
      };
      byCombo.set(line.comboSetId, group);
      keysSeen.set(line.comboSetId, new Set());
      groups.push(group);
    }
    keysSeen.get(line.comboSetId)!.add(line.comboKey);
    group.lines.push(line);

    // Returns come off both sides at once, exactly as computeOrderTotals does
    // it: a returned piece takes its share of the saving back with it, so the
    // figure on the invoice and the figure in the profit report agree.
    const kept = Math.max(0, line.quantity - line.returned);
    const fraction = line.quantity > 0 ? kept / line.quantity : 0;
    group.gross = round2(group.gross + line.unitPrice * kept);
    group.discount = round2(group.discount + line.discount * fraction);
    group.returned += line.returned;
  }

  let comboDiscount = 0;
  for (const [comboSetId, group] of byCombo) {
    group.sets = keysSeen.get(comboSetId)?.size ?? 0;
    group.net = round2(group.gross - group.discount);
    comboDiscount = round2(comboDiscount + group.discount);
  }

  return { groups, comboDiscount };
}
