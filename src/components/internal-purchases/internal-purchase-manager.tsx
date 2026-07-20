"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createInternalPurchase,
  updateInternalPurchase,
  deleteInternalPurchase,
} from "@/server/actions/internal-purchases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { Receipt } from "lucide-react";

type Item = {
  id: string;
  date: string;
  itemName: string;
  description: string | null;
  supplierName: string | null;
  paidBy: string | null;
  paidByPartnerId: string | null;
  cost: number;
  quantity: number;
  category: string;
};
type Perms = { canAdd: boolean; canEdit: boolean };
const NO_PARTNER = "__none__";

const CATEGORIES = [
  "OFFICE_SUPPLIES",
  "PACKAGING_MATERIAL",
  "EQUIPMENT",
  "UTILITIES",
  "OTHER",
];
const LABEL: Record<string, string> = {
  OFFICE_SUPPLIES: "Office supplies",
  PACKAGING_MATERIAL: "Packaging material",
  EQUIPMENT: "Equipment",
  UTILITIES: "Utilities",
  OTHER: "Other",
};

export function InternalPurchaseManager({
  slug,
  items,
  partnerOptions,
  perms,
}: {
  slug: string;
  items: Item[];
  partnerOptions: { id: string; label: string }[];
  perms: Perms;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [category, setCategory] = useState("OTHER");
  const [paidByPartnerId, setPaidByPartnerId] = useState(NO_PARTNER);
  const [loading, setLoading] = useState(false);
  const [catFilter, setCatFilter] = useState("__all__");

  const filtered = items.filter((i) => catFilter === "__all__" || i.category === catFilter);

  function openNew() {
    setEditing(null);
    setCategory("OTHER");
    setPaidByPartnerId(NO_PARTNER);
    setOpen(true);
  }
  function openEdit(i: Item) {
    setEditing(i);
    setCategory(i.category);
    setPaidByPartnerId(i.paidByPartnerId ?? NO_PARTNER);
    setOpen(true);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("category", category);
    fd.set("paidByPartnerId", paidByPartnerId === NO_PARTNER ? "" : paidByPartnerId);
    const res = editing
      ? await updateInternalPurchase(slug, editing.id, fd)
      : await createInternalPurchase(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(editing ? "Updated" : "Added");
    setOpen(false);
    router.refresh();
  }

  async function onDelete(i: Item) {
    if (!confirm(`Delete "${i.itemName}"?`)) return;
    const res = await deleteInternalPurchase(slug, i.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={catFilter} onValueChange={(v) => setCatFilter(v ?? "__all__")}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {LABEL[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {perms.canAdd && (
          <Button size="sm" onClick={openNew}>
            + Add entry
          </Button>
        )}
      </div>

      <DataTable
        rows={filtered}
        rowKey={(i) => i.id}
        empty={{ icon: Receipt, title: "No entries" }}
        columns={
          [
            { key: "date", header: "Date", cell: (i) => i.date },
            {
              key: "item",
              header: "Item",
              cardTitle: true,
              cell: (i) => (
                <span>
                  {i.itemName}
                  {i.description && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {i.description}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "category",
              header: "Category",
              cell: (i) => <Badge variant="secondary">{LABEL[i.category] ?? i.category}</Badge>,
            },
            { key: "supplier", header: "Supplier", cell: (i) => i.supplierName ?? "—" },
            { key: "paidBy", header: "Paid by", cell: (i) => i.paidBy ?? "—" },
            { key: "cost", header: "Cost", align: "right", cell: (i) => i.cost.toFixed(2) },
            { key: "qty", header: "Qty", align: "right", cell: (i) => i.quantity },
            {
              key: "total",
              header: "Total",
              align: "right",
              cell: (i) => (i.cost * i.quantity).toFixed(2),
            },
            ...(perms.canEdit
              ? [
                  {
                    key: "actions",
                    header: "",
                    cardFullWidth: true,
                    cell: (i: Item) => (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(i)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onDelete(i)}>
                          Delete
                        </Button>
                      </>
                    ),
                  },
                ]
              : []),
          ] as Column<Item>[]
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit entry" : "Add internal purchase"}</DialogTitle>
          </DialogHeader>
          <form key={editing?.id ?? "new"} onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ip-name">Item name</Label>
              <Input id="ip-name" name="itemName" required defaultValue={editing?.itemName ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ip-desc">Description</Label>
              <Textarea id="ip-desc" name="description" defaultValue={editing?.description ?? ""} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={category} onValueChange={(v) => setCategory(v ?? "OTHER")}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ip-supplier">Supplier / shop</Label>
                <Input id="ip-supplier" name="supplierName" defaultValue={editing?.supplierName ?? ""} />
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
                <Label htmlFor="ip-cost">Unit cost</Label>
                <Input id="ip-cost" name="cost" type="number" step="0.01" min="0" required defaultValue={editing?.cost ?? ""} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ip-qty">Quantity</Label>
                <Input id="ip-qty" name="quantity" type="number" min="1" required defaultValue={editing?.quantity ?? 1} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ip-date">Date</Label>
                <Input id="ip-date" name="date" type="date" required defaultValue={editing?.date} />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
