"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type VariantOption = { id: string; label: string; stock: number };
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
  variantOptions,
  adjustments,
  canEdit,
}: {
  slug: string;
  variantOptions: VariantOption[];
  adjustments: Adjustment[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [variantId, setVariantId] = useState("");
  const [type, setType] = useState("DAMAGED");
  const [direction, setDirection] = useState("REMOVE");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!variantId) return toast.error("Select a product variant");
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("productVariantId", variantId);
    fd.set("type", type);
    fd.set("direction", type === "CORRECTION" ? direction : "REMOVE");
    const res = await createStockAdjustment(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Adjustment recorded");
    (e.target as HTMLFormElement).reset();
    setVariantId("");
    router.refresh();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this adjustment?")) return;
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
            {variantOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a product variant first.</p>
            ) : (
              <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Product / variant</Label>
                  <Select value={variantId} onValueChange={(v) => setVariantId(v ?? "")}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a product variant" />
                    </SelectTrigger>
                    <SelectContent>
                      {variantOptions.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label} · {v.stock} in stock
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
        {adjustments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">None recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead>Reason</TableHead>
                {canEdit && <TableHead className="w-16" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.date}</TableCell>
                  <TableCell className="font-medium">{a.product}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{LABEL[a.type] ?? a.type}</Badge>
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${a.delta < 0 ? "text-destructive" : "text-green-600"}`}
                  >
                    {a.delta > 0 ? "+" : ""}
                    {a.delta}
                  </TableCell>
                  <TableCell>{a.reason ?? "—"}</TableCell>
                  {canEdit && (
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(a.id)}>
                        Delete
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
