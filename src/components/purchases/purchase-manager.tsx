"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deletePurchase } from "@/server/actions/purchases";
import { submitOrQueue } from "@/lib/offline-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PackageOpen } from "lucide-react";

type VariantOption = { id: string; label: string; expiryTracked: boolean };
type PurchaseRow = {
  id: string;
  date: string;
  product: string;
  supplier: string;
  unitCost: number;
  quantity: number;
  expiryDate: string | null;
};
type Perms = { canAdd: boolean; canEdit: boolean };

const NO_SUPPLIER = "__none__";

export function PurchaseManager({
  slug,
  variantOptions,
  suppliers,
  purchases,
  perms,
}: {
  slug: string;
  variantOptions: VariantOption[];
  suppliers: { id: string; name: string }[];
  purchases: PurchaseRow[];
  perms: Perms;
}) {
  const router = useRouter();
  const today = purchases[0]?.date ?? "";
  const [variantId, setVariantId] = useState("");
  const [supplierId, setSupplierId] = useState<string>(NO_SUPPLIER);
  const [loading, setLoading] = useState(false);

  const selectedVariant = variantOptions.find((v) => v.id === variantId);
  const showExpiry = selectedVariant?.expiryTracked ?? false;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!variantId) {
      toast.error("Select a product variant");
      return;
    }
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("productVariantId", variantId);
    fd.set("supplierId", supplierId === NO_SUPPLIER ? "" : supplierId);
    const payload = Object.fromEntries(fd.entries()) as Record<string, unknown>;
    const res = await submitOrQueue("purchase.create", slug, payload);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed");
      return;
    }
    toast.success(res.queued ? "Saved offline — will sync when online" : "Purchase recorded");
    (e.target as HTMLFormElement).reset();
    setVariantId("");
    setSupplierId(NO_SUPPLIER);
    router.refresh();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this purchase entry?")) return;
    const res = await deletePurchase(slug, id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Purchase deleted");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {perms.canAdd && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record a purchase</CardTitle>
          </CardHeader>
          <CardContent>
            {variantOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add a product with at least one variant first.
              </p>
            ) : (
              <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Product / variant</Label>
                  <Select
                    value={variantId}
                    onValueChange={(v) => setVariantId(v ?? "")}
                    items={variantOptions.map((v) => ({ value: v.id, label: v.label }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a product variant" />
                    </SelectTrigger>
                    <SelectContent>
                      {variantOptions.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Supplier</Label>
                  <Select
                    value={supplierId}
                    onValueChange={(v) => setSupplierId(v ?? NO_SUPPLIER)}
                    items={[
                      { value: NO_SUPPLIER, label: "No supplier" },
                      ...suppliers.map((s) => ({ value: s.id, label: s.name })),
                    ]}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SUPPLIER}>No supplier</SelectItem>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="date">Date</Label>
                  <Input id="date" name="date" type="date" required defaultValue={today || undefined} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unitCost">Unit cost</Label>
                  <Input id="unitCost" name="unitCost" type="number" step="0.01" min="0" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input id="quantity" name="quantity" type="number" min="1" required />
                </div>
                {showExpiry && (
                  <div className="space-y-2">
                    <Label htmlFor="expiryDate">Expiry date</Label>
                    <Input id="expiryDate" name="expiryDate" type="date" />
                  </div>
                )}
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={loading}>
                    {loading ? "Saving…" : "Record purchase"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Recent purchases</h2>
        <DataTable
          rows={purchases}
          rowKey={(p) => p.id}
          empty={{ icon: PackageOpen, title: "No purchases recorded yet" }}
          columns={
            [
              { key: "date", header: "Date", cell: (p) => p.date },
              { key: "product", header: "Product", cardTitle: true, cell: (p) => p.product },
              { key: "supplier", header: "Supplier", cell: (p) => p.supplier },
              {
                key: "unitCost",
                header: "Unit cost",
                align: "right",
                cell: (p) => p.unitCost.toFixed(2),
              },
              { key: "quantity", header: "Qty", align: "right", cell: (p) => p.quantity },
              { key: "expiry", header: "Expiry", cell: (p) => p.expiryDate ?? "—" },
              ...(perms.canEdit
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (p: PurchaseRow) => (
                        <Button variant="ghost" size="sm" onClick={() => onDelete(p.id)}>
                          Delete
                        </Button>
                      ),
                    },
                  ]
                : []),
            ] as Column<PurchaseRow>[]
          }
        />
      </div>
    </div>
  );
}
