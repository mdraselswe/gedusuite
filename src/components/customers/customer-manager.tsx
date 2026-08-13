"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "@/lib/live-router";
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
import { Money } from "@/components/ui/money";
import { Field, FormError, type FieldError } from "@/components/ui/field";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  address: string | null;
  notes: string | null;
  orderCount: number;
  /** Parcels they refused. Kept out of orderCount and spend, counted here. */
  cancelledCount: number;
  outstanding: number;
  /** Everything they have actually bought, at what they were charged. */
  lifetime: number;
  lastOrderDay: string | null;
  daysSinceOrder: number | null;
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
  // The last refusal, kept so the Field it names can show it. A toast alone
  // left the message hovering over a form with no sign of which box it meant.
  const [formError, setFormError] = useState<FieldError>(null);
  const [query, setQuery] = useState("");
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
      // Names the question, not one of the answers: the label doubles as the
      // "any" row at the top of the dropdown, so calling it "Has ordered" put
      // "Has ordered" in the list twice.
      label: "Ordered before",
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
    {
      key: "refused",
      label: "Refused a parcel",
      kind: "select",
      options: [
        { value: "yes", label: "Has refused" },
        { value: "no", label: "Never refused" },
      ],
      match: (c, v) => (v === "yes" ? c.cancelledCount > 0 : c.cancelledCount === 0),
    },
    { key: "spend", label: "Lifetime spend", kind: "numberRange", value: (c) => c.lifetime },
  ];

  const { rows: byFilters, bar, active } = useFilterBar(customers, filters, {
    // Both figures, because "due" alone next to a filtered list reads as the
    // whole shop's — the header carries that one.
    summary: (shown) => (
      <span className="text-muted-foreground">
        Due{" "}
        <span className="font-semibold text-foreground tabular-nums">
          <Money value={shown.reduce((s, c) => s + c.outstanding, 0)} />
        </span>
        {" · spent "}
        <span className="font-semibold text-foreground tabular-nums">
          <Money value={shown.reduce((s, c) => s + c.lifetime, 0)} />
        </span>
      </span>
    ),
  });

  // Search stays its own control: it is typed constantly, the filters are set
  // occasionally, and pairing them in one panel would hide the common one.
  const filtered = byFilters.filter((c) => {
    const q = query.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.phone ?? "").includes(query) ||
      (c.altPhone ?? "").includes(query)
    );
  });

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
    if (!res.ok) {
      setFormError(res);
      if (!res.field) toast.error(res.error);
      return;
    }
    setFormError(null);
    toast.success("Customer deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {/* Search then filters, the same two-line-safe row every other manager
          uses. This one was a fixed `flex` holding four things — search, a
          "Dues only" toggle, a total, and the filter bar — so on anything
          narrower than a desktop they ran off the edge instead of wrapping.
          The toggle went with them: the Dues filter beside it does the same
          job and says more, and the two could contradict each other into an
          empty table with nothing to explain why. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search name or phone…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-xs"
          />
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
                  {/* Worth seeing before packing another parcel for them: a
                      refusal costs the return charge whether or not they ever
                      buy anything. */}
                  {c.cancelledCount > 0 && (
                    <Badge
                      variant="outline"
                      className="ml-2 border-amber-400/60 text-amber-700 dark:text-amber-400"
                      title={`${c.cancelledCount} order(s) cancelled or refused`}
                    >
                      {c.cancelledCount} refused
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
              key: "lifetime",
              // Order count alone said who orders often, never who is worth
              // anything — five 300-taka orders and one 9,000 one read the same.
              header: "Spent",
              align: "right",
              hideable: true,
              sortValue: (c) => c.lifetime,
              cell: (c) => (c.lifetime > 0 ? <Money value={c.lifetime} /> : "—"),
            },
            {
              key: "lastOrder",
              header: "Last order",
              hideable: true,
              // Sorts by how long ago, so one sort puts the customers who have
              // gone quiet at one end — never-ordered last, since "no order at
              // all" isn't a gap that grew.
              sortValue: (c) => c.daysSinceOrder ?? Number.MAX_SAFE_INTEGER,
              cell: (c) =>
                c.lastOrderDay === null ? (
                  <span className="text-muted-foreground">never</span>
                ) : (
                  <span>
                    {c.lastOrderDay}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {c.daysSinceOrder === 0
                        ? "today"
                        : c.daysSinceOrder === 1
                          ? "yesterday"
                          : `${c.daysSinceOrder} days ago`}
                    </span>
                  </span>
                ),
            },
            {
              key: "outstanding",
              header: "Outstanding",
              align: "right",
              sortValue: (c) => c.outstanding,
              cell: (c) =>
                c.outstanding > 0 ? (
                  <span className="font-semibold text-destructive">
                    <Money value={c.outstanding} />
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
            <Field name="name" error={formError} label="Name" required>
              <Input id="c-name" name="name" required defaultValue={editing?.name ?? ""} />
            </Field>
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
            <Field name="address" error={formError} label="Address">
              <Input id="c-address" name="address" defaultValue={editing?.address ?? ""} />
            </Field>
            <Field name="notes" error={formError} label="Notes">
              <Textarea id="c-notes" name="notes" defaultValue={editing?.notes ?? ""} />
            </Field>
            <FormError error={formError} />
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
