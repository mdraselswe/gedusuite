"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { updateCustomer, deleteCustomer } from "@/server/actions/customers";
import { submitOrQueue } from "@/lib/offline-queue";
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
import { DataTable, type Column } from "@/components/ui/data-table";
import { Users } from "lucide-react";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  address: string | null;
  notes: string | null;
  orderCount: number;
  outstanding: number;
};
type Perms = { canAdd: boolean; canEdit: boolean };

export function CustomerManager({
  slug,
  customers,
  perms,
}: {
  slug: string;
  customers: Customer[];
  perms: Perms;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [duesOnly, setDuesOnly] = useState(false);

  const filtered = customers.filter((c) => {
    const matches =
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      (c.phone ?? "").includes(query) ||
      (c.altPhone ?? "").includes(query);
    return matches && (!duesOnly || c.outstanding > 0);
  });

  const totalDue = customers.reduce((s, c) => s + c.outstanding, 0);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const res = editing
      ? await updateCustomer(slug, editing.id, fd)
      : await submitOrQueue(
          "customer.create",
          slug,
          Object.fromEntries(fd.entries()) as Record<string, unknown>,
        );
    setLoading(false);
    if (!res.ok) return toast.error(res.error ?? "Failed");
    toast.success(
      editing
        ? "Customer updated"
        : "queued" in res && res.queued
          ? "Saved offline — will sync when online"
          : "Customer added",
    );
    setOpen(false);
    router.refresh();
  }

  async function onDelete(c: Customer) {
    const ok = await confirmDialog({
      title: "Delete customer?",
      description: `"${c.name}" will be permanently deleted.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteCustomer(slug, c.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Customer deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search name or phone…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-xs"
          />
          <Button
            variant={duesOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setDuesOnly((v) => !v)}
          >
            Dues only
          </Button>
          <span className="text-sm text-muted-foreground">
            Total due: <span className="font-semibold">{totalDue.toFixed(2)}</span>
          </span>
        </div>
        {perms.canAdd && (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            + Add customer
          </Button>
        )}
      </div>

      <DataTable
        rows={filtered}
        rowKey={(c) => c.id}
        empty={{
          icon: Users,
          title: "No customers",
          description: perms.canAdd ? "Add a customer to track orders and dues." : undefined,
        }}
        columns={
          [
            {
              key: "name",
              header: "Name",
              cardTitle: true,
              wrap: true,
              sortValue: (c) => c.name.toLowerCase(),
              cell: (c) => (
                <span>
                  {c.name}
                  {c.orderCount > 1 && (
                    <Badge variant="secondary" className="ml-2">
                      Repeat
                    </Badge>
                  )}
                </span>
              ),
            },
            {
              key: "phone",
              header: "Phone",
              hideable: true,
              cell: (c) => (
                <span>
                  {c.phone ?? "—"}
                  {c.altPhone && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {c.altPhone}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "orders",
              header: "Orders",
              align: "right",
              sortValue: (c) => c.orderCount,
              cell: (c) => c.orderCount,
            },
            {
              key: "outstanding",
              header: "Outstanding",
              align: "right",
              sortValue: (c) => c.outstanding,
              cell: (c) =>
                c.outstanding > 0 ? (
                  <span className="font-semibold text-destructive">
                    {c.outstanding.toFixed(2)}
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              key: "actions",
              header: "",
              cardFullWidth: true,
              cell: (c: Customer) => (
                <>
                  <Link
                    href={`/${slug}/customers/${c.id}`}
                    className="inline-flex items-center text-sm underline underline-offset-4"
                  >
                    History
                  </Link>
                  {perms.canEdit && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(c);
                          setOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(c)}>
                        Delete
                      </Button>
                    </>
                  )}
                </>
              ),
            },
          ] as Column<Customer>[]
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit customer" : "Add customer"}</DialogTitle>
          </DialogHeader>
          <form key={editing?.id ?? "new"} onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="c-name">Name</Label>
              <Input id="c-name" name="name" required defaultValue={editing?.name ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-phone">Phone</Label>
              <Input id="c-phone" name="phone" defaultValue={editing?.phone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-alt-phone">Alternate phone</Label>
              <Input id="c-alt-phone" name="altPhone" defaultValue={editing?.altPhone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-address">Address</Label>
              <Input id="c-address" name="address" defaultValue={editing?.address ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-notes">Notes</Label>
              <Textarea id="c-notes" name="notes" defaultValue={editing?.notes ?? ""} />
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
