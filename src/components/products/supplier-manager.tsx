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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No suppliers found.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Address</TableHead>
              {perms.canEdit && <TableHead className="w-24" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell>{s.phone ?? "—"}</TableCell>
                <TableCell>{s.address ?? "—"}</TableCell>
                {perms.canEdit && (
                  <TableCell className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onDelete(s)}>
                      Delete
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit supplier" : "Add supplier"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
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
