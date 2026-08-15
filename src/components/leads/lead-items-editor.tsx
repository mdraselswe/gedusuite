"use client";

import { Plus, Trash2 } from "lucide-react";
import { AsyncCombobox } from "@/components/ui/async-combobox";
import { searchVariants, type VariantOption } from "@/server/actions/search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLeadItems, parseLeadItem, splitLeadItems } from "@/lib/lead-items";
import { formatStock } from "@/lib/units";
import { round2 } from "@/lib/money";

/**
 * One row per item, because a website order routinely has several and typing
 * them into a single box invites a different wording every time.
 *
 * A row is either a catalogue product or a free-typed name: the call list also
 * receives orders for things that were never added as products, and refusing
 * those would make the form useless exactly when someone is on the phone.
 * Either way the rows compose into the same one-line string the WooCommerce
 * sync writes, so a hand-typed order and an imported one read alike.
 */

export type ItemRow = {
  id: number;
  /** A typed name rather than a catalogue pick. Carried on the row itself so
   *  an existing order can be loaded back into the form for editing — its
   *  items are stored as text and which product they were isn't recoverable. */
  free: boolean;
  /** Set when picked from the catalogue; null for a free-typed row. */
  option: VariantOption | null;
  /** Used only by free-typed rows. */
  text: string;
  qty: string;
};

let nextId = 1;
export const newItemRow = (free = false): ItemRow => ({
  id: nextId++,
  free,
  option: null,
  text: "",
  qty: "1",
});

/** Load a stored "Name x2, Other x1" string back into editable rows. */
export function rowsFromItemsText(text: string): ItemRow[] {
  const rows = splitLeadItems(text).map((entry) => {
    const { name, qty } = parseLeadItem(entry);
    return { id: nextId++, free: true, option: null, text: name, qty: String(qty) };
  });
  return rows.length ? rows : [newItemRow()];
}

/** What the rows add up to, when every picked product has a price. */
export function itemsTotal(rows: ItemRow[]): number | null {
  const priced = rows.filter((r) => r.option?.salePrice != null);
  if (priced.length === 0 || priced.length !== rows.filter((r) => rowName(r)).length) return null;
  const sum = priced.reduce((s, r) => s + (r.option!.salePrice ?? 0) * qtyOf(r), 0);
  return round2(sum);
}

export const rowName = (r: ItemRow) => (r.option ? r.option.label : r.text.trim());
const qtyOf = (r: ItemRow) => Math.max(1, Math.trunc(Number(r.qty)) || 1);

/** The single string that goes to the server. */
export function rowsToItemsText(rows: ItemRow[]): string {
  return formatLeadItems(rows.map((r) => ({ name: rowName(r), qty: qtyOf(r) })));
}

export function LeadItemsEditor({
  slug,
  rows,
  onChange,
}: {
  slug: string;
  rows: ItemRow[];
  onChange: (rows: ItemRow[]) => void;
}) {
  const patch = (id: number, next: Partial<ItemRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));
  const remove = (id: number) => onChange(rows.filter((r) => r.id !== id));
  const add = (free: boolean) => onChange([...rows, newItemRow(free)]);

  return (
    <div className="grid gap-2">
      <Label>Items</Label>

      {rows.map((row) => (
        <div key={row.id} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {row.free ? (
              <Input
                placeholder="Item name"
                value={row.text}
                maxLength={200}
                onChange={(e) => patch(row.id, { text: e.target.value })}
              />
            ) : (
              <AsyncCombobox<VariantOption>
                value={row.option}
                onChange={(o) => patch(row.id, { option: o })}
                fetchPage={async (q, cursor) => {
                  const res = await searchVariants(slug, q, cursor);
                  return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                }}
                placeholder="Search product…"
                renderItem={(o) => (
                  <>
                    <span className="truncate">{o.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatStock(o.stock, o.unitsPerPack)} in stock
                    </span>
                  </>
                )}
              />
            )}
          </div>
          <Input
            type="number"
            min={1}
            step={1}
            aria-label="Quantity"
            className="w-20 shrink-0"
            value={row.qty}
            onChange={(e) => patch(row.id, { qty: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Remove item"
            className="shrink-0"
            // The last row is emptied rather than removed: a form with no item
            // row at all reads as broken.
            onClick={() =>
              rows.length > 1
                ? remove(row.id)
                : patch(row.id, { option: null, text: "", qty: "1" })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => add(false)}>
          <Plus data-icon="inline-start" />
          Add item
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => add(true)}>
          Not in the catalogue — type it
        </Button>
      </div>
    </div>
  );
}
