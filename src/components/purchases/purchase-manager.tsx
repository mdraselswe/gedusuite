"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updatePurchase, deletePurchase } from "@/server/actions/purchases";
import { submitOrQueue } from "@/lib/offline-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PackageOpen } from "lucide-react";

// Local calendar date (not UTC) as a stable "today" default — must NOT depend
// on props/state that change after mount (e.g. the newest purchase's date),
// or an uncontrolled <Input defaultValue> on this always-mounted form would
// get a changing defaultValue post-init and trip Base UI's dev warning.
function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

type VariantOption = { id: string; label: string; expiryTracked: boolean };
type PurchaseRow = {
  id: string;
  date: string;
  productVariantId: string;
  product: string;
  supplierId: string | null;
  supplier: string;
  paidByPartnerId: string | null;
  paidBy: string | null;
  unitCost: number;
  quantity: number;
  expiryDate: string | null;
};
type Perms = { canAdd: boolean; canEdit: boolean };

const NO_SUPPLIER = "__none__";
const NO_PARTNER = "__none__";

export function PurchaseManager({
  slug,
  variantOptions,
  suppliers,
  partnerOptions,
  purchases,
  perms,
}: {
  slug: string;
  variantOptions: VariantOption[];
  suppliers: { id: string; name: string }[];
  partnerOptions: { id: string; label: string }[];
  purchases: PurchaseRow[];
  perms: Perms;
}) {
  const router = useRouter();
  const [variantId, setVariantId] = useState("");
  const [supplierId, setSupplierId] = useState<string>(NO_SUPPLIER);
  const [paidByPartnerId, setPaidByPartnerId] = useState<string>(NO_PARTNER);
  const [loading, setLoading] = useState(false);

  const selectedVariant = variantOptions.find((v) => v.id === variantId);
  const showExpiry = selectedVariant?.expiryTracked ?? false;

  // Edit dialog state — separate controlled fields from the always-visible
  // "record a purchase" form above.
  const [editing, setEditing] = useState<PurchaseRow | null>(null);
  const [editVariantId, setEditVariantId] = useState("");
  const [editSupplierId, setEditSupplierId] = useState<string>(NO_SUPPLIER);
  const [editPaidByPartnerId, setEditPaidByPartnerId] = useState<string>(NO_PARTNER);
  const [editLoading, setEditLoading] = useState(false);

  const editSelectedVariant = variantOptions.find((v) => v.id === editVariantId);
  const editShowExpiry = editSelectedVariant?.expiryTracked ?? false;

  function openEdit(p: PurchaseRow) {
    setEditing(p);
    setEditVariantId(p.productVariantId);
    setEditSupplierId(p.supplierId ?? NO_SUPPLIER);
    setEditPaidByPartnerId(p.paidByPartnerId ?? NO_PARTNER);
  }

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
    fd.set("paidByPartnerId", paidByPartnerId === NO_PARTNER ? "" : paidByPartnerId);
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
    setPaidByPartnerId(NO_PARTNER);
    router.refresh();
  }

  async function onSubmitEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    if (!editVariantId) {
      toast.error("Select a product variant");
      return;
    }
    setEditLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("productVariantId", editVariantId);
    fd.set("supplierId", editSupplierId === NO_SUPPLIER ? "" : editSupplierId);
    fd.set("paidByPartnerId", editPaidByPartnerId === NO_PARTNER ? "" : editPaidByPartnerId);
    const res = await updatePurchase(slug, editing.id, fd);
    setEditLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Purchase updated");
    setEditing(null);
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
                  <Label>Paid by (partner)</Label>
                  <Select
                    value={paidByPartnerId}
                    onValueChange={(v) => setPaidByPartnerId(v ?? NO_PARTNER)}
                    items={[
                      { value: NO_PARTNER, label: "Not tracked" },
                      ...partnerOptions.map((p) => ({ value: p.id, label: p.label })),
                    ]}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PARTNER}>Not tracked</SelectItem>
                      {partnerOptions.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="date">Date</Label>
                  <Input id="date" name="date" type="date" required defaultValue={todayInputValue()} />
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
              { key: "paidBy", header: "Paid by", cell: (p) => p.paidBy ?? "—" },
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
                        <>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                            Edit
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => onDelete(p.id)}>
                            Delete
                          </Button>
                        </>
                      ),
                    },
                  ]
                : []),
            ] as Column<PurchaseRow>[]
          }
        />
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit purchase</DialogTitle>
          </DialogHeader>
          {editing && (
            <form
              key={editing.id}
              onSubmit={onSubmitEdit}
              className="grid gap-4 sm:grid-cols-2"
            >
              <div className="space-y-2 sm:col-span-2">
                <Label>Product / variant</Label>
                <Select
                  value={editVariantId}
                  onValueChange={(v) => setEditVariantId(v ?? "")}
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
                  value={editSupplierId}
                  onValueChange={(v) => setEditSupplierId(v ?? NO_SUPPLIER)}
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
                <Label>Paid by (partner)</Label>
                <Select
                  value={editPaidByPartnerId}
                  onValueChange={(v) => setEditPaidByPartnerId(v ?? NO_PARTNER)}
                  items={[
                    { value: NO_PARTNER, label: "Not tracked" },
                    ...partnerOptions.map((p) => ({ value: p.id, label: p.label })),
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PARTNER}>Not tracked</SelectItem>
                    {partnerOptions.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-date">Date</Label>
                <Input
                  id="edit-date"
                  name="date"
                  type="date"
                  required
                  defaultValue={editing.date}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-unitCost">Unit cost</Label>
                <Input
                  id="edit-unitCost"
                  name="unitCost"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  defaultValue={editing.unitCost}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-quantity">Quantity</Label>
                <Input
                  id="edit-quantity"
                  name="quantity"
                  type="number"
                  min="1"
                  required
                  defaultValue={editing.quantity}
                />
              </div>
              {editShowExpiry && (
                <div className="space-y-2">
                  <Label htmlFor="edit-expiryDate">Expiry date</Label>
                  <Input
                    id="edit-expiryDate"
                    name="expiryDate"
                    type="date"
                    defaultValue={editing.expiryDate ?? ""}
                  />
                </div>
              )}
              <DialogFooter className="sm:col-span-2">
                <Button type="submit" disabled={editLoading}>
                  {editLoading ? "Saving…" : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
