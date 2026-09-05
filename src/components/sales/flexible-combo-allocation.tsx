"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StockDemand } from "@/lib/combos";
import type { ComboOptionForOrder } from "@/server/actions/combos";

export function FlexibleComboAllocation({
  combo, sets, allocation, error, onChange, onReset,
}: {
  combo: ComboOptionForOrder;
  sets: number;
  allocation: StockDemand[];
  error: string | null;
  onChange: (allocation: StockDemand[]) => void;
  onReset: () => void;
}) {
  const groups = [...new Set(combo.components.map((k) => k.productId))]
    .map((id) => combo.components.filter((k) => k.productId === id));
  const quantities = new Map(allocation.map((a) => [a.productVariantId, a.quantity]));

  function updateQuantity(productVariantId: string, quantity: number) {
    onChange(combo.components.map((c) => ({
      productVariantId: c.productVariantId,
      quantity: c.productVariantId === productVariantId
        ? quantity
        : quantities.get(c.productVariantId) ?? 0,
    })));
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium">Mixed variants: quantities for {sets} {sets === 1 ? "set" : "sets"}</p>
      <p className="text-xs text-muted-foreground">All variants of this product are available. Adjust the suggested mix to match what you will pack.</p>
      {groups.map((group) => (
        <p key={group[0].productId} className="text-xs font-medium">
          {group[0].productName}: {group.reduce((n, k) => n + k.quantity, 0) * sets} pieces required
        </p>
      ))}
      {combo.components.map((k) => (
        <label key={k.productVariantId} className="flex items-center justify-between gap-3 text-xs">
          <span>{k.label} ({k.stock} in stock)</span>
          <Input
            type="number"
            min="0"
            step="1"
            className="h-8 w-20"
            aria-label={`Quantity of ${k.label}`}
            value={quantities.get(k.productVariantId) ?? 0}
            onChange={(e) => updateQuantity(k.productVariantId, Number(e.target.value))}
          />
        </label>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={onReset}>
        Reset to stock suggestion
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
