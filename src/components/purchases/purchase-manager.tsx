"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AsyncCombobox } from "@/components/ui/async-combobox";
import { searchVariants, type VariantOption } from "@/server/actions/search";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatStock } from "@/lib/units";
import { Columns3, MoreVertical, PackageOpen, X } from "lucide-react";

// Local calendar date (not UTC) as a stable "today" default — must NOT depend
// on props/state that change after mount (e.g. the newest purchase's date),
// or an uncontrolled <Input defaultValue> on this always-mounted form would
// get a changing defaultValue post-init and trip Base UI's dev warning.
function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

type PurchaseRow = {
  id: string;
  date: string;
  productVariantId: string;
  product: string;
  expiryTracked: boolean;
  unitsPerPack: number | null;
  supplierId: string | null;
  supplier: string;
  paidByPartnerId: string | null;
  paidBy: string | null;
  paidFromTreasury: boolean;
  unitCost: number;
  salePrice: number | null;
  quantity: number;
  expiryDate: string | null;
};
type Perms = { canAdd: boolean; canEdit: boolean };
type FundingSource = "NONE" | "PARTNER" | "TREASURY";

const NO_SUPPLIER = "__none__";
const NO_PARTNER = "__none__";

// Optional (toggleable) columns for the Recent purchases table. Date, product,
// qty, and total always show; the rest start hidden to keep the table narrow.
const OPTIONAL_COLUMNS = [
  { key: "supplier", label: "Supplier" },
  { key: "funding", label: "Funding" },
  { key: "unitCost", label: "Unit cost" },
  { key: "salePrice", label: "Sale price" },
  { key: "expiry", label: "Expiry" },
] as const;

const SORT_OPTIONS = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "cost_desc", label: "Unit cost: high → low" },
  { value: "cost_asc", label: "Unit cost: low → high" },
  { value: "qty_desc", label: "Quantity: high → low" },
  { value: "qty_asc", label: "Quantity: low → high" },
];

function fundingSourceOf(p: { paidByPartnerId: string | null; paidFromTreasury: boolean }): FundingSource {
  if (p.paidFromTreasury) return "TREASURY";
  if (p.paidByPartnerId) return "PARTNER";
  return "NONE";
}

export function PurchaseManager({
  slug,
  hasProducts,
  suppliers,
  partnerOptions,
  purchases,
  treasuryBalance,
  perms,
  query,
  sort,
}: {
  slug: string;
  hasProducts: boolean;
  suppliers: { id: string; name: string }[];
  partnerOptions: { id: string; label: string }[];
  purchases: PurchaseRow[];
  treasuryBalance: number;
  perms: Perms;
  query: string;
  sort: string;
}) {
  const router = useRouter();

  // ── List toolbar: URL-driven search + sort, local column visibility ──
  const [search, setSearch] = useState(query);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set(["salePrice"]));
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function pushListParams(nextQ: string, nextSort: string) {
    const params = new URLSearchParams();
    if (nextQ.trim()) params.set("q", nextQ.trim());
    if (nextSort !== "date_desc") params.set("sort", nextSort);
    // Search/sort changes restart from page 1 (no page param).
    router.replace(`/${slug}/purchases${params.size ? `?${params}` : ""}`);
  }

  function onSearchChange(v: string) {
    setSearch(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => pushListParams(v, sort), 400);
  }
  useEffect(() => {
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, []);

  function toggleColumn(key: string) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const [variant, setVariant] = useState<VariantOption | null>(null);
  const [supplierId, setSupplierId] = useState<string>(NO_SUPPLIER);
  const [fundingSource, setFundingSource] = useState<FundingSource>("NONE");
  const [paidByPartnerId, setPaidByPartnerId] = useState<string>(NO_PARTNER);
  const [buyUnit, setBuyUnit] = useState<"PIECE" | "PACK">("PIECE");
  const [loading, setLoading] = useState(false);

  const showExpiry = variant?.expiryTracked ?? false;
  // Pack-based product: quantities/costs can be entered per packet — always
  // converted to per-piece before hitting the server (stock stays in pieces).
  const upp = variant?.unitsPerPack && variant.unitsPerPack > 1 ? variant.unitsPerPack : null;
  const buyingByPack = !!upp && buyUnit === "PACK";

  // Edit dialog state — separate controlled fields from the always-visible
  // "record a purchase" form above.
  const [editing, setEditing] = useState<PurchaseRow | null>(null);
  const [editVariant, setEditVariant] = useState<VariantOption | null>(null);
  const [editSupplierId, setEditSupplierId] = useState<string>(NO_SUPPLIER);
  const [editFundingSource, setEditFundingSource] = useState<FundingSource>("NONE");
  const [editPaidByPartnerId, setEditPaidByPartnerId] = useState<string>(NO_PARTNER);
  // Controlled so the Packet/Piece toggle can re-express the same purchase in
  // either unit (stored values are always per-piece).
  const [editBuyUnit, setEditBuyUnit] = useState<"PIECE" | "PACK">("PIECE");
  const [editQty, setEditQty] = useState("");
  const [editCost, setEditCost] = useState("");
  const [editSale, setEditSale] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const editShowExpiry = editVariant?.expiryTracked ?? false;
  const editUpp =
    editVariant?.unitsPerPack && editVariant.unitsPerPack > 1 ? editVariant.unitsPerPack : null;
  const editByPack = !!editUpp && editBuyUnit === "PACK";

  const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

  function openEdit(p: PurchaseRow) {
    setEditing(p);
    // Seed the combobox from the row itself (the variant may not be in any
    // fetched search page). Stock isn't shown in this form, so 0 is fine.
    setEditVariant({ value: p.productVariantId, label: p.product, stock: 0, expiryTracked: p.expiryTracked, unitCost: 0, salePrice: null, unitsPerPack: p.unitsPerPack });
    setEditSupplierId(p.supplierId ?? NO_SUPPLIER);
    setEditFundingSource(fundingSourceOf(p));
    setEditPaidByPartnerId(p.paidByPartnerId ?? NO_PARTNER);
    setEditBuyUnit("PIECE");
    setEditQty(String(p.quantity));
    setEditCost(String(p.unitCost));
    setEditSale(p.salePrice != null ? String(p.salePrice) : "");
  }

  /** Re-express the edit fields in the other unit (values stay equivalent). */
  function switchEditUnit(next: "PIECE" | "PACK") {
    if (!editUpp || next === editBuyUnit) return setEditBuyUnit(next);
    const qty = parseFloat(editQty) || 0;
    const cost = parseFloat(editCost) || 0;
    const sale = parseFloat(editSale);
    if (next === "PACK") {
      setEditQty(String(qty / editUpp));
      setEditCost(String(round2(cost * editUpp)));
      if (!Number.isNaN(sale)) setEditSale(String(round2(sale * editUpp)));
    } else {
      setEditQty(String(Math.round(qty * editUpp)));
      setEditCost(String(round2(cost / editUpp)));
      if (!Number.isNaN(sale)) setEditSale(String(round2(sale / editUpp)));
    }
    setEditBuyUnit(next);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!variant) {
      toast.error("Select a product variant");
      return;
    }
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("productVariantId", variant.value);
    fd.set("supplierId", supplierId === NO_SUPPLIER ? "" : supplierId);
    fd.set("fundingSource", fundingSource);
    fd.set("paidByPartnerId", fundingSource === "PARTNER" && paidByPartnerId !== NO_PARTNER ? paidByPartnerId : "");
    if (buyingByPack && upp) {
      // Entered per packet → stored per piece.
      const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
      const qty = parseInt(String(fd.get("quantity") || "0"));
      const cost = parseFloat(String(fd.get("unitCost") || "0"));
      const sale = String(fd.get("salePrice") || "");
      fd.set("quantity", String(qty * upp));
      fd.set("unitCost", String(round2(cost / upp)));
      if (sale) fd.set("salePrice", String(round2(parseFloat(sale) / upp)));
    }
    const payload = Object.fromEntries(fd.entries()) as Record<string, unknown>;
    const res = await submitOrQueue("purchase.create", slug, payload);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed");
      return;
    }
    toast.success(res.queued ? "Saved offline — will sync when online" : "Purchase recorded");
    (e.target as HTMLFormElement).reset();
    setVariant(null);
    setSupplierId(NO_SUPPLIER);
    setFundingSource("NONE");
    setPaidByPartnerId(NO_PARTNER);
    setBuyUnit("PIECE");
    router.refresh();
  }

  async function onSubmitEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    if (!editVariant) {
      toast.error("Select a product variant");
      return;
    }
    setEditLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("productVariantId", editVariant.value);
    fd.set("supplierId", editSupplierId === NO_SUPPLIER ? "" : editSupplierId);
    fd.set("fundingSource", editFundingSource);
    fd.set(
      "paidByPartnerId",
      editFundingSource === "PARTNER" && editPaidByPartnerId !== NO_PARTNER ? editPaidByPartnerId : "",
    );
    // Controlled fields → per-piece values (packet entries get converted).
    const qty = parseFloat(editQty) || 0;
    const cost = parseFloat(editCost) || 0;
    fd.set("quantity", String(editByPack && editUpp ? Math.round(qty * editUpp) : qty));
    fd.set("unitCost", String(editByPack && editUpp ? round2(cost / editUpp) : cost));
    if (editSale.trim()) {
      const sale = parseFloat(editSale) || 0;
      fd.set("salePrice", String(editByPack && editUpp ? round2(sale / editUpp) : sale));
    } else {
      fd.set("salePrice", "");
    }
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
    const ok = await confirmDialog({
      title: "Delete purchase?",
      description: "The purchased stock will be removed; a linked treasury deduction (if any) is reversed.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
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
            {!hasProducts ? (
              <p className="text-sm text-muted-foreground">
                Add a product with at least one variant first.
              </p>
            ) : (
              <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Product / variant</Label>
                  <AsyncCombobox
                    value={variant}
                    onChange={(v) => {
                      setVariant(v);
                      // Pack-based products are normally bought by the packet —
                      // default to PACK (standard purchase UoM); toggle stays
                      // available for loose-piece buys.
                      setBuyUnit(v?.unitsPerPack && v.unitsPerPack > 1 ? "PACK" : "PIECE");
                    }}
                    fetchPage={async (q, cursor) => {
                      const res = await searchVariants(slug, q, cursor);
                      return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                    }}
                    placeholder="Search product…"
                    renderItem={(o) => (
                      <>
                        <span className="truncate">{o.label}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatStock(o.stock, o.unitsPerPack)} in stock</span>
                      </>
                    )}
                  />
                </div>
                {upp && (
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Buying unit</Label>
                    <Select value={buyUnit} onValueChange={(v) => setBuyUnit((v as "PIECE" | "PACK") ?? "PIECE")}>
                      <SelectTrigger className="w-full sm:w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PIECE">Single pieces</SelectItem>
                        <SelectItem value="PACK">Packets ({upp} pcs each)</SelectItem>
                      </SelectContent>
                    </Select>
                    {buyingByPack && (
                      <p className="text-xs text-muted-foreground">
                        Quantity and prices below are per packet — saved automatically as {upp}{" "}
                        pieces per packet with per-piece cost.
                      </p>
                    )}
                  </div>
                )}
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
                    </SelectContent>
                  </Select>
                  {fundingSource === "TREASURY" && (
                    <p className="text-xs text-muted-foreground">
                      Treasury balance: {treasuryBalance.toFixed(2)}
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
                <div className="space-y-2">
                  <Label htmlFor="date">Date</Label>
                  <Input id="date" name="date" type="date" required defaultValue={todayInputValue()} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unitCost">{buyingByPack ? "Cost per packet" : "Unit cost"}</Label>
                  <Input id="unitCost" name="unitCost" type="number" step="0.01" min="0" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="salePrice">
                    {buyingByPack ? "Sale price (per packet)" : "Sale price (per unit)"}
                  </Label>
                  <Input
                    id="salePrice"
                    name="salePrice"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Intended selling price — optional"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quantity">{buyingByPack ? "Quantity (packets)" : "Quantity"}</Label>
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
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Input
              placeholder="Search product or supplier…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className={search ? "pr-8" : undefined}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  if (searchDebounce.current) clearTimeout(searchDebounce.current);
                  setSearch("");
                  pushListParams("", sort);
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Select value={sort} onValueChange={(v) => v && pushListParams(search, v)} items={SORT_OPTIONS}>
            <SelectTrigger className="w-60">
              <span className="shrink-0 text-muted-foreground">Sort:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Columns3 data-icon="inline-start" />
              Columns
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {OPTIONAL_COLUMNS.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={visibleCols.has(c.key)}
                  onCheckedChange={() => toggleColumn(c.key)}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DataTable
          rows={purchases}
          rowKey={(p) => p.id}
          stickyHeader
          empty={{
            icon: PackageOpen,
            title: query ? "No purchases match your search" : "No purchases recorded yet",
          }}
          columns={
            [
              { key: "date", header: "Date", cell: (p) => p.date },
              {
                key: "product",
                header: "Product",
                cardTitle: true,
                wrap: true,
                cell: (p) => p.product,
              },
              ...(visibleCols.has("supplier")
                ? [{ key: "supplier", header: "Supplier", wrap: true, cell: (p: PurchaseRow) => p.supplier }]
                : []),
              ...(visibleCols.has("funding")
                ? [
                    {
                      key: "funding",
                      header: "Funding",
                      cell: (p: PurchaseRow) =>
                        p.paidFromTreasury ? "Treasury" : p.paidBy ? `Partner: ${p.paidBy}` : "—",
                    },
                  ]
                : []),
              ...(visibleCols.has("unitCost")
                ? [
                    {
                      key: "unitCost",
                      header: "Unit cost",
                      align: "right" as const,
                      cell: (p: PurchaseRow) => p.unitCost.toFixed(2),
                    },
                  ]
                : []),
              ...(visibleCols.has("salePrice")
                ? [
                    {
                      key: "salePrice",
                      header: "Sale price",
                      align: "right" as const,
                      cell: (p: PurchaseRow) => (p.salePrice != null ? p.salePrice.toFixed(2) : "—"),
                    },
                  ]
                : []),
              { key: "quantity", header: "Qty", align: "right", cell: (p) => p.quantity },
              {
                key: "total",
                header: "Total",
                align: "right",
                cell: (p) => <span className="font-medium">{(p.unitCost * p.quantity).toFixed(2)}</span>,
              },
              ...(visibleCols.has("expiry")
                ? [{ key: "expiry", header: "Expiry", cell: (p: PurchaseRow) => p.expiryDate ?? "—" }]
                : []),
              ...(perms.canEdit
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (p: PurchaseRow) => (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="ghost" size="icon-sm" aria-label="Actions" title="Actions" />}
                          >
                            <MoreVertical className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(p)}>Edit</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => onDelete(p.id)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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
                <AsyncCombobox
                  value={editVariant}
                  onChange={setEditVariant}
                  fetchPage={async (q, cursor) => {
                    const res = await searchVariants(slug, q, cursor);
                    return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                  }}
                  placeholder="Search product…"
                  renderItem={(o) => (
                    <>
                      <span className="truncate">{o.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatStock(o.stock, o.unitsPerPack)} in stock</span>
                    </>
                  )}
                />
              </div>
              {editUpp && (
                <div className="space-y-2 sm:col-span-2">
                  <Label>Buying unit</Label>
                  <Select
                    value={editBuyUnit}
                    onValueChange={(v) => switchEditUnit((v as "PIECE" | "PACK") ?? "PIECE")}
                  >
                    <SelectTrigger className="w-full sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PIECE">Single pieces</SelectItem>
                      <SelectItem value="PACK">Packets ({editUpp} pcs each)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Switching re-expresses the same values in the other unit — saved per piece
                    either way.
                  </p>
                </div>
              )}
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
                <Label>Funding source</Label>
                <Select
                  value={editFundingSource}
                  onValueChange={(v) => setEditFundingSource((v as FundingSource) ?? "NONE")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Not tracked</SelectItem>
                    <SelectItem value="PARTNER">Partner</SelectItem>
                    <SelectItem value="TREASURY">Treasury</SelectItem>
                  </SelectContent>
                </Select>
                {editFundingSource === "TREASURY" && (
                  <p className="text-xs text-muted-foreground">
                    Treasury balance: {treasuryBalance.toFixed(2)}
                    {editing?.paidFromTreasury ? " (excluding this entry's current amount)" : ""}
                  </p>
                )}
              </div>
              {editFundingSource === "PARTNER" && (
                <div className="space-y-2">
                  <Label>Partner</Label>
                  <Select
                    value={editPaidByPartnerId}
                    onValueChange={(v) => setEditPaidByPartnerId(v ?? NO_PARTNER)}
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
                <Label htmlFor="edit-unitCost">{editByPack ? "Cost per packet" : "Unit cost"}</Label>
                <Input
                  id="edit-unitCost"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={editCost}
                  onChange={(e) => setEditCost(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-salePrice">
                  {editByPack ? "Sale price (per packet)" : "Sale price (per unit)"}
                </Label>
                <Input
                  id="edit-salePrice"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Optional"
                  value={editSale}
                  onChange={(e) => setEditSale(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-quantity">
                  {editByPack ? "Quantity (packets)" : "Quantity"}
                </Label>
                <Input
                  id="edit-quantity"
                  type="number"
                  step="any"
                  min="0"
                  required
                  value={editQty}
                  onChange={(e) => setEditQty(e.target.value)}
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
