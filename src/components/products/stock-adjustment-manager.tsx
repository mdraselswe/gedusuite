"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  createStockAdjustment,
  deleteStockAdjustment,
} from "@/server/actions/stock-adjustments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AsyncCombobox } from "@/components/ui/async-combobox";
import { searchVariants, type VariantOption } from "@/server/actions/search";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ClipboardList } from "lucide-react";

type Adjustment = {
  id: string;
  date: string;
  product: string;
  type: string;
  delta: number;
  reason: string | null;
};

const TYPES = ["DAMAGED", "LOST", "GIFT", "CORRECTION"];
const LABEL: Record<string, string> = {
  DAMAGED: "Damaged",
  LOST: "Lost",
  GIFT: "Gift",
  CORRECTION: "Correction",
};

export function StockAdjustmentManager({
  slug,
  hasProducts,
  adjustments,
  canEdit,
}: {
  slug: string;
  hasProducts: boolean;
  adjustments: Adjustment[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [variant, setVariant] = useState<VariantOption | null>(null);
  const [type, setType] = useState("DAMAGED");
  const [direction, setDirection] = useState("REMOVE");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!variant) return toast.error("Select a product variant");
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("productVariantId", variant.value);
    fd.set("type", type);
    fd.set("direction", type === "CORRECTION" ? direction : "REMOVE");
    const res = await createStockAdjustment(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Adjustment recorded");
    (e.target as HTMLFormElement).reset();
    setVariant(null);
    router.refresh();
  }

  async function onDelete(id: string) {
    const ok = await confirmDialog({
      title: "Delete adjustment?",
      description: "The stock change from this adjustment will be reversed.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteStockAdjustment(slug, id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Deleted");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record stock adjustment</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasProducts ? (
              <p className="text-sm text-muted-foreground">Add a product variant first.</p>
            ) : (
              <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Product / variant</Label>
                  <AsyncCombobox
                    value={variant}
                    onChange={setVariant}
                    fetchPage={async (q, cursor) => {
                      const res = await searchVariants(slug, q, cursor);
                      return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                    }}
                    placeholder="Search product…"
                    renderItem={(o) => (
                      <>
                        <span className="truncate">{o.label}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{o.stock} in stock</span>
                      </>
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={type} onValueChange={(v) => setType(v ?? "DAMAGED")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {type === "CORRECTION" && (
                  <div className="space-y-2">
                    <Label>Direction</Label>
                    <Select value={direction} onValueChange={(v) => setDirection(v ?? "REMOVE")}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ADD">Add to stock</SelectItem>
                        <SelectItem value="REMOVE">Remove from stock</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="sa-qty">Quantity</Label>
                  <Input id="sa-qty" name="quantity" type="number" min="1" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sa-date">Date</Label>
                  <Input id="sa-date" name="date" type="date" required />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="sa-reason">Reason</Label>
                  <Input id="sa-reason" name="reason" />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={loading}>
                    {loading ? "Saving…" : "Record adjustment"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Recent adjustments</h2>
        <DataTable
          rows={adjustments}
          rowKey={(a) => a.id}
          empty={{ icon: ClipboardList, title: "No adjustments recorded" }}
          columns={
            [
              { key: "date", header: "Date", cell: (a) => a.date },
              { key: "product", header: "Product", cardTitle: true, cell: (a) => a.product },
              {
                key: "type",
                header: "Type",
                cell: (a) => <Badge variant="secondary">{LABEL[a.type] ?? a.type}</Badge>,
              },
              {
                key: "delta",
                header: "Change",
                align: "right",
                cell: (a) => (
                  <span className={a.delta < 0 ? "text-destructive" : "text-green-600"}>
                    {a.delta > 0 ? "+" : ""}
                    {a.delta}
                  </span>
                ),
              },
              { key: "reason", header: "Reason", cell: (a) => a.reason ?? "—" },
              ...(canEdit
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (a: Adjustment) => (
                        <Button variant="ghost" size="sm" onClick={() => onDelete(a.id)}>
                          Delete
                        </Button>
                      ),
                    },
                  ]
                : []),
            ] as Column<Adjustment>[]
          }
        />
      </div>
    </div>
  );
}
