"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "@/server/actions/suppliers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Truck } from "lucide-react";

type Supplier = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  notes: string | null;
};

type Perms = { canAdd: boolean; canEdit: boolean };

export function SupplierManager({
  slug,
  suppliers,
  perms,
}: {
  slug: string;
  suppliers: Supplier[];
  perms: Perms;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const shown = suppliers.filter((s) => {
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.phone ?? "").includes(query);
  });

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(s: Supplier) {
    setEditing(s);
    setOpen(true);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const res = editing
      ? await updateSupplier(slug, editing.id, fd)
      : await createSupplier(slug, fd);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(editing ? "Supplier updated" : "Supplier added");
    setOpen(false);
    router.refresh();
  }

  async function onDelete(s: Supplier) {
    if (!confirm(`Delete supplier "${s.name}"?`)) return;
    const res = await deleteSupplier(slug, s.id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Supplier deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Input
          placeholder="Search suppliers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        {perms.canAdd && (
          <Button size="sm" onClick={openNew}>
            + Add supplier
          </Button>
        )}
      </div>

      <DataTable
        rows={shown}
        rowKey={(s) => s.id}
        empty={{
          icon: Truck,
          title: "No suppliers found",
          description: perms.canAdd
            ? "Add a supplier to reuse across purchase entries."
            : undefined,
        }}
        columns={
          [
            { key: "name", header: "Name", cardTitle: true, cell: (s) => s.name },
            { key: "phone", header: "Phone", cell: (s) => s.phone ?? "—" },
            { key: "address", header: "Address", cell: (s) => s.address ?? "—" },
            ...(perms.canEdit
              ? [
                  {
                    key: "actions",
                    header: "",
                    cardFullWidth: true,
                    cell: (s: Supplier) => (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onDelete(s)}>
                          Delete
                        </Button>
                      </>
                    ),
                  },
                ]
              : []),
          ] as Column<Supplier>[]
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit supplier" : "Add supplier"}</DialogTitle>
          </DialogHeader>
          <form key={editing?.id ?? "new"} onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="s-name">Name</Label>
              <Input id="s-name" name="name" required defaultValue={editing?.name ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-phone">Phone</Label>
              <Input id="s-phone" name="phone" defaultValue={editing?.phone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-address">Address</Label>
              <Input id="s-address" name="address" defaultValue={editing?.address ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-notes">Notes</Label>
              <Textarea id="s-notes" name="notes" defaultValue={editing?.notes ?? ""} />
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
