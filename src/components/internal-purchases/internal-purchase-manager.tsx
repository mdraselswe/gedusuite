"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
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
import { type ComboOption } from "@/components/ui/async-combobox";
import { SupplierPicker } from "@/components/products/supplier-picker";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import {
  readLastFundingSource,
  writeLastFundingSource,
  type FundingSource as SharedFundingSource,
} from "@/lib/last-funding-source";
import { Receipt } from "lucide-react";
import { Money } from "@/components/ui/money";
import { formatMoney as money } from "@/lib/money";
import { Field, FormError, type FieldError } from "@/components/ui/field";

type Item = {
  id: string;
  date: string;
  itemName: string;
  description: string | null;
  supplierId: string | null;
  supplierName: string | null;
  paidBy: string | null;
  paidByPartnerId: string | null;
  paidFromTreasury: boolean;
  /** Bought on account and still owed for. */
  onCredit: boolean;
  cost: number;
  quantity: number;
  /** Months the cost covers, or null when it's charged in full on its date. */
  spreadMonths: number | null;
  category: string;
};
type Perms = { canAdd: boolean; canEdit: boolean };
// Deliberately the shared type rather than a second copy: a fourth funding
// state added in one place and missed in the other is how a form silently stops
// offering it.
type FundingSource = SharedFundingSource;
const NO_PARTNER = "__none__";

function fundingSourceOf(i: {
  paidByPartnerId: string | null;
  paidFromTreasury: boolean;
  onCredit: boolean;
}): FundingSource {
  if (i.paidFromTreasury) return "TREASURY";
  if (i.paidByPartnerId) return "PARTNER";
  if (i.onCredit) return "CREDIT";
  return "NONE";
}

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
  treasuryBalance,
  perms,
}: {
  slug: string;
  items: Item[];
  partnerOptions: { id: string; label: string }[];
  treasuryBalance: number;
  perms: Perms;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [category, setCategory] = useState("OTHER");
  const [supplier, setSupplier] = useState<ComboOption | null>(null);
  // Seeded from the last choice on this device — see last-funding-source.
  const [fundingSource, setFundingSource] = useState<FundingSource>(() =>
    readLastFundingSource(slug, "internal-purchase"),
  );
  const [paidByPartnerId, setPaidByPartnerId] = useState(NO_PARTNER);
  const [loading, setLoading] = useState(false);
  // The last refusal, kept so the Field it names can show it. A toast alone
  // left the message hovering over a form with no sign of which box it meant.
  const [formError, setFormError] = useState<FieldError>(null);
  // Cost, quantity and spread are controlled so the per-month preview below
  // can react as they're typed. The rest of the form stays uncontrolled.
  const [costInput, setCostInput] = useState("");
  const [qtyInput, setQtyInput] = useState("1");
  const [spread, setSpread] = useState("");

  // What the entered figures mean per month, said back to them. "12" is
  // abstract; "405.08 a month for 12 months" is the decision being made.
  const spreadPreview = (() => {
    const months = parseInt(spread, 10);
    if (!Number.isFinite(months) || months < 1) return null;
    const total = (parseFloat(costInput) || 0) * (parseInt(qtyInput, 10) || 1);
    if (total <= 0) return `Charged evenly across ${months} month(s).`;
    return `${money(total / months)} a month for ${months} month(s), from the date above.`;
  })();
  const filters: FilterDef<Item>[] = [
    {
      key: "category",
      label: "All categories",
      kind: "select",
      primary: true,
      options: CATEGORIES.map((c) => ({ value: c, label: LABEL[c] })),
      match: (i, v) => i.category === v,
    },
    {
      key: "funding",
      label: "Paid with",
      kind: "select",
      options: [
        { value: "PARTNER", label: "A partner's money" },
        { value: "TREASURY", label: "Treasury" },
        { value: "CREDIT", label: "On credit (unpaid)" },
        { value: "NONE", label: "Not recorded" },
      ],
      match: (i, v) => fundingSourceOf(i) === v,
    },
    {
      key: "partner",
      label: "Which partner",
      kind: "select",
      options: partnerOptions.map((p) => ({ value: p.id, label: p.label })),
      match: (i, v) => i.paidByPartnerId === v,
    },
    {
      key: "supplier",
      label: "Supplier",
      kind: "select",
      options: [...new Map(
        items.filter((i) => i.supplierId && i.supplierName).map((i) => [i.supplierId!, i.supplierName!]),
      )].map(([value, label]) => ({ value, label })),
      match: (i, v) => i.supplierId === v,
    },
    { key: "date", label: "Date range", kind: "dateRange", value: (i) => i.date },
    {
      key: "total",
      label: "Total spent",
      kind: "numberRange",
      value: (i) => i.cost * i.quantity,
    },
  ];

  const { rows: filtered, bar, active } = useFilterBar(items, filters, {
    summary: (shown) => (
      <span className="text-muted-foreground">
        Spent{" "}
        <span className="font-semibold text-foreground tabular-nums">
          <Money value={shown.reduce((s, i) => s + i.cost * i.quantity, 0)} />
        </span>
      </span>
    ),
  });

  function openNew() {
    setEditing(null);
    setCostInput("");
    setQtyInput("1");
    setSpread("");
    setCategory("OTHER");
    setSupplier(null);
    setFundingSource(readLastFundingSource(slug, "internal-purchase"));
    setPaidByPartnerId(NO_PARTNER);
    setOpen(true);
  }
  function openEdit(i: Item) {
    setEditing(i);
    setCostInput(String(i.cost));
    setQtyInput(String(i.quantity));
    setSpread(i.spreadMonths != null ? String(i.spreadMonths) : "");
    setCategory(i.category);
    setSupplier(i.supplierId && i.supplierName ? { value: i.supplierId, label: i.supplierName } : null);
    setFundingSource(fundingSourceOf(i));
    setPaidByPartnerId(i.paidByPartnerId ?? NO_PARTNER);
    setOpen(true);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("category", category);
    fd.set("supplierId", supplier?.value ?? "");
    fd.set("fundingSource", fundingSource);
    fd.set("paidByPartnerId", fundingSource === "PARTNER" && paidByPartnerId !== NO_PARTNER ? paidByPartnerId : "");
    const res = editing
      ? await updateInternalPurchase(slug, editing.id, fd)
      : await createInternalPurchase(slug, fd);
    setLoading(false);
    if (!res.ok) {
      setFormError(res);
      if (!res.field) toast.error(res.error);
      return;
    }
    setFormError(null);
    // Only a fresh entry says anything about how this shop funds things now;
    // correcting an old row shouldn't change what the next new one defaults to.
    if (!editing) writeLastFundingSource(slug, "internal-purchase", fundingSource);
    toast.success(editing ? "Updated" : "Added");
    setOpen(false);
    router.refresh();
  }

  async function onDelete(i: Item) {
    const ok = await confirmDialog({
      title: "Delete entry?",
      description: `"${i.itemName}" will be deleted; a linked treasury deduction (if any) is reversed.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteInternalPurchase(slug, i.id);
    if (!res.ok) {
      setFormError(res);
      if (!res.field) toast.error(res.error);
      return;
    }
    setFormError(null);
    toast.success("Deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{bar}</div>
        {perms.canAdd && (
          <Button size="sm" onClick={openNew}>
            + Add entry
          </Button>
        )}
      </div>

      <DataTable
        rows={filtered}
        rowKey={(i) => i.id}
        colorGroupBy={(i) => i.date}
        colorToggleLabel="Color by date"
        searchText={(i) => `${i.itemName} ${i.description ?? ""} ${i.supplierName ?? ""} ${i.category}`}
        searchPlaceholder="Search item, supplier…"
        empty={{
          icon: Receipt,
          title: active > 0 ? "No entries match these filters" : "No entries",
        }}
        columns={
          [
            { key: "date", header: "Date", cell: (i) => i.date, sortValue: (i) => i.date },
            {
              key: "item",
              header: "Item",
              cardTitle: true,
              wrap: true,
              sortValue: (i) => i.itemName.toLowerCase(),
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
              hideable: true,
              cell: (i) => <Badge variant="secondary">{LABEL[i.category] ?? i.category}</Badge>,
            },
            { key: "supplier", header: "Supplier", hideable: true, wrap: true, cell: (i) => i.supplierName ?? "—" },
            {
              key: "funding",
              header: "Funding",
              hideable: true,
              cell: (i) =>
                i.paidFromTreasury
                  ? "Treasury"
                  : i.paidBy
                    ? `Partner: ${i.paidBy}`
                    : i.onCredit
                      ? "On credit"
                      : "—",
            },
            { key: "cost", header: "Cost", align: "right", hideable: true, sortValue: (i) => i.cost, cell: (i) => <Money value={i.cost} /> },
            {
              key: "spread",
              header: "Spread",
              align: "right",
              hideable: true,
              sortValue: (i) => i.spreadMonths ?? 0,
              cell: (i) =>
                i.spreadMonths ? (
                  <span className="text-muted-foreground">{i.spreadMonths} mo</span>
                ) : (
                  "—"
                ),
            },
            { key: "qty", header: "Qty", align: "right", sortValue: (i) => i.quantity, cell: (i) => i.quantity },
            {
              key: "total",
              header: "Total",
              align: "right",
              sortValue: (i) => i.cost * i.quantity,
              cell: (i) => <Money value={i.cost * i.quantity} />,
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
            <Field name="itemName" error={formError} label="Item name" required>
              <Input id="ip-name" name="itemName" required defaultValue={editing?.itemName ?? ""} />
            </Field>
            <Field name="description" error={formError} label="Description">
              <Textarea id="ip-desc" name="description" defaultValue={editing?.description ?? ""} />
            </Field>
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
                <Label>Supplier / shop</Label>
                <SupplierPicker slug={slug} value={supplier} onChange={setSupplier} />
              </div>
              <div className="space-y-2">
                <Label>Funding source</Label>
                <Select
                  value={fundingSource}
                  onValueChange={(v) => setFundingSource((v as FundingSource) ?? "NONE")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Not tracked</SelectItem>
                    <SelectItem value="PARTNER">Partner</SelectItem>
                    <SelectItem value="TREASURY">Treasury</SelectItem>
                    <SelectItem value="CREDIT">On credit (owed to supplier)</SelectItem>
                  </SelectContent>
                </Select>
                {fundingSource === "TREASURY" && (
                  <p className="text-xs text-muted-foreground">
                    Treasury balance: <Money value={treasuryBalance} />
                    {editing?.paidFromTreasury ? " (excluding this entry's current amount)" : ""}
                  </p>
                )}
              </div>
              {fundingSource === "PARTNER" && (
                <div className="space-y-2">
                  <Label>Partner</Label>
                  <Select
                    value={paidByPartnerId}
                    onValueChange={(v) => setPaidByPartnerId(v ?? NO_PARTNER)}
                    items={partnerOptions.map((p) => ({ value: p.id, label: p.label }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select partner" />
                    </SelectTrigger>
                    <SelectContent>
                      {partnerOptions.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Field name="cost" error={formError} label="Unit cost" required>
                <Input
                  id="ip-cost"
                  name="cost"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                />
              </Field>
              <Field name="quantity" error={formError} label="Quantity" required>
                <Input
                  id="ip-qty"
                  name="quantity"
                  type="number"
                  min="1"
                  required
                  value={qtyInput}
                  onChange={(e) => setQtyInput(e.target.value)}
                />
              </Field>
              <Field name="date" error={formError} label="Date" required>
                <Input id="ip-date" name="date" type="date" required defaultValue={editing?.date} />
              </Field>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ip-spread">Spread over (months)</Label>
                <Input
                  id="ip-spread"
                  name="spreadMonths"
                  type="number"
                  min="1"
                  max="120"
                  placeholder="Leave blank to charge it all to this month"
                  value={spread}
                  onChange={(e) => setSpread(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {spreadPreview ??
                    "A year of hosting isn't this month's expense. Enter 12 and it's charged across the twelve months it covers instead — the money still left the account today, and the treasury still says so."}
                </p>
              </div>
            </div>
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
