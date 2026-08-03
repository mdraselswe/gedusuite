"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { updateCustomer, deleteCustomer, findCustomerByPhone } from "@/server/actions/customers";
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
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import { Users, AlertTriangle } from "lucide-react";

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
  const [phoneMatch, setPhoneMatch] = useState<{ id: string; name: string } | null>(null);

  async function checkPhone(value: string) {
    setPhoneMatch(null);
    if (!value.trim()) return;
    const found = await findCustomerByPhone(slug, value);
    // Editing a customer always "matches" itself; that isn't a duplicate.
    if (found && found.id !== editing?.id) setPhoneMatch(found);
  }

  const filters: FilterDef<Customer>[] = [
    {
      key: "dues",
      label: "Dues",
      kind: "select",
      options: [
        { value: "owing", label: "Owes money" },
        { value: "clear", label: "Nothing owing" },
      ],
      match: (c, v) => (v === "owing" ? c.outstanding > 0 : c.outstanding <= 0),
    },
    {
      key: "ordered",
      label: "Has ordered",
      kind: "select",
      options: [
        { value: "yes", label: "Has ordered" },
        { value: "no", label: "Never ordered" },
      ],
      match: (c, v) => (v === "yes" ? c.orderCount > 0 : c.orderCount === 0),
    },
    {
      key: "outstanding",
      label: "Outstanding amount",
      kind: "numberRange",
      value: (c) => c.outstanding,
    },
    { key: "orders", label: "Order count", kind: "numberRange", step: "1", value: (c) => c.orderCount },
  ];

  const { rows: byFilters, bar, active } = useFilterBar(customers, filters, {
    summary: (shown) => (
      <span className="text-muted-foreground">
        Due{" "}
        <span className="font-semibold text-foreground tabular-nums">
          {shown.reduce((s, c) => s + c.outstanding, 0).toFixed(2)}
        </span>
      </span>
    ),
  });

  // Search stays its own control: it is typed constantly, the filters are set
  // occasionally, and pairing them in one panel would hide the common one.
  const filtered = byFilters.filter((c) => {
    if (duesOnly && c.outstanding <= 0) return false;
    const q = query.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.phone ?? "").includes(query) ||
      (c.altPhone ?? "").includes(query)
    );
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
          {bar}
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
          title: active > 0 ? "No customers match these filters" : "No customers",
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

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // Don't carry a warning from the last customer into the next one.
          if (!o) setPhoneMatch(null);
        }}
      >
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
              <Input
                id="c-phone"
                name="phone"
                defaultValue={editing?.phone ?? ""}
                onBlur={(e) => checkPhone(e.currentTarget.value)}
              />
              {/* Advisory only. A shared family or shop number is a real, if
                  rare, thing — but the same person entered twice splits their
                  order history and outstanding balance, which is the far more
                  common accident. */}
              {phoneMatch && (
                <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>
                    This number is already on <strong>{phoneMatch.name}</strong> — same person?
                    Saving anyway creates a second customer.
                  </span>
                </p>
              )}
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
