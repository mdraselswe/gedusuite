"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  addVariant,
  deleteVariant,
} from "@/server/actions/products";
import { createProductCategory } from "@/server/actions/product-categories";
import { variantChip } from "@/lib/variants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { EmptyState } from "@/components/ui/empty-state";
import { ProductImportDialog } from "@/components/products/product-import-dialog";
import { SkuBuilder } from "@/components/products/sku-builder";
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import { formatStock } from "@/lib/units";
import { Package } from "lucide-react";
import { formatMoney as money } from "@/lib/money";

const ADD_NEW_CATEGORY = "__add_new__";

type VariantAttribute = { name: string; value: string };
type Variant = {
  id: string;
  attributes: VariantAttribute[];
  sku: string | null;
  barcode: string | null;
  description: string | null;
  imageUrl: string | null;
  salePrice: number | null;
  unitCost: number | null;
  lowStockThreshold: number | null;
  stock: number;
};
type Product = {
  id: string;
  name: string;
  category: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  expiryTracked: boolean;
  lowStockThreshold: number;
  unitsPerPack: number | null;
  weightGrams: number | null;
  attributeNames: string[];
  variants: Variant[];
};
type Perms = { canAdd: boolean; canEdit: boolean };

// Editable form row for one variant. `values` is positionally aligned with the
// product's attribute-name list, so renaming/reordering an attribute never
// desynchronises a variant's values. Prices/threshold are kept as strings while
// editing and coerced on the server.
type VariantDraft = {
  id?: string;
  values: string[];
  sku: string;
  barcode: string;
  description: string;
  imageUrl: string;
  salePrice: string;
  unitCost: string;
  lowStockThreshold: string;
};

const MAX_IMAGE_BYTES = 1_400_000;
const IMAGE_MAX_DIMENSION = 480; // px, longest side — plenty for a list thumbnail
const IMAGE_QUALITY = 0.72;

/**
 * Downscale + recompress an image client-side before it ever becomes a
 * stored data URI. Shrinking to a 480px JPEG typically lands at 15-60KB
 * regardless of the original file size.
 */
function downscaleImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("Invalid image"));
      img.onload = () => {
        const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unsupported"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function fileToDataUri(file: File): Promise<string | null> {
  if (file.size > MAX_IMAGE_BYTES) {
    toast.error("Image too large (max ~1.4MB)");
    return null;
  }
  try {
    return await downscaleImage(file);
  } catch {
    toast.error("Couldn't process that image");
    return null;
  }
}

const emptyDraft = (attrCount: number): VariantDraft => ({
  values: Array(attrCount).fill(""),
  sku: "",
  barcode: "",
  description: "",
  imageUrl: "",
  salePrice: "",
  unitCost: "",
  lowStockThreshold: "",
});

function draftFromVariant(v: Variant, names: string[]): VariantDraft {
  const byName = new Map(v.attributes.map((a) => [a.name, a.value]));
  return {
    id: v.id,
    values: names.map((n) => byName.get(n) ?? ""),
    sku: v.sku ?? "",
    barcode: v.barcode ?? "",
    description: v.description ?? "",
    imageUrl: v.imageUrl ?? "",
    salePrice: v.salePrice != null ? String(v.salePrice) : "",
    unitCost: v.unitCost != null ? String(v.unitCost) : "",
    lowStockThreshold: v.lowStockThreshold != null ? String(v.lowStockThreshold) : "",
  };
}

// Build the server payload for one variant draft against the given attr names.
function draftPayload(d: VariantDraft, names: string[]) {
  return {
    id: d.id,
    attributes: names
      .map((name, i) => ({ name: name.trim(), value: (d.values[i] ?? "").trim() }))
      .filter((a) => a.name && a.value),
    sku: d.sku,
    barcode: d.barcode,
    description: d.description,
    imageUrl: d.imageUrl,
    salePrice: d.salePrice,
    unitCost: d.unitCost,
    lowStockThreshold: d.lowStockThreshold,
  };
}


export function ProductManager({
  slug,
  products,
  categories,
  perms,
}: {
  slug: string;
  products: Product[];
  categories: string[];
  perms: Perms;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [categoryList, setCategoryList] = useState(categories);

  // Add-category dialog (opened from the product form's category select).
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categorySaving, setCategorySaving] = useState(false);

  // Stock and price live on the variants, so a product's figure is the sum
  // (stock) or the cheapest (price) across them — what a person means when
  // they ask "which products are under 200".
  const stockOf = (p: Product) => p.variants.reduce((s, v) => s + v.stock, 0);
  const priceOf = (p: Product) => {
    const prices = p.variants.map((v) => v.salePrice).filter((x): x is number => x != null);
    return prices.length ? Math.min(...prices) : 0;
  };

  const filters: FilterDef<Product>[] = [
    {
      key: "category",
      label: "All categories",
      kind: "select",
      primary: true,
      options: categories.map((c) => ({ value: c, label: c })),
      match: (p, v) => p.category === v,
    },
    {
      key: "stock",
      label: "Stock level",
      kind: "select",
      options: [
        { value: "out", label: "Out of stock" },
        { value: "low", label: "At or below threshold" },
        { value: "in", label: "In stock" },
      ],
      match: (p, v) => {
        const n = stockOf(p);
        if (v === "out") return n <= 0;
        if (v === "low") return n > 0 && n <= p.lowStockThreshold;
        return n > 0;
      },
    },
    {
      key: "shape",
      label: "Product shape",
      kind: "select",
      options: [
        { value: "variants", label: "Has variants" },
        { value: "single", label: "Single variant" },
        { value: "pack", label: "Sold in packs" },
        { value: "expiry", label: "Expiry tracked" },
      ],
      match: (p, v) => {
        if (v === "variants") return p.attributeNames.length > 0;
        if (v === "single") return p.attributeNames.length === 0;
        if (v === "pack") return !!p.unitsPerPack;
        return p.expiryTracked;
      },
    },
    {
      key: "sku",
      label: "SKU",
      kind: "select",
      options: [
        { value: "yes", label: "Has a SKU" },
        { value: "no", label: "Missing a SKU" },
      ],
      match: (p, v) => (v === "yes" ? !!p.sku : !p.sku),
    },
    { key: "qty", label: "Stock on hand", kind: "numberRange", step: "1", value: stockOf },
    { key: "price", label: "Sale price", kind: "numberRange", value: priceOf },
  ];

  const { rows: byFilters, bar, active } = useFilterBar(products, filters, {
    summary: (rows) => (
      <span className="text-muted-foreground">
        Stock{" "}
        <span className="font-semibold text-foreground tabular-nums">
          {rows.reduce((s, p) => s + stockOf(p), 0)}
        </span>{" "}
        pieces
      </span>
    ),
  });

  // Search stays its own box: it is typed constantly, the filters are set
  // occasionally, and folding one into the other would hide the common case.
  const shown = byFilters.filter((p) => {
    const q = query.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.category ?? "").toLowerCase().includes(q) ||
      (p.sku ?? "").toLowerCase().includes(q) ||
      (p.barcode ?? "").toLowerCase().includes(q)
    );
  });

  // Controlled product-dialog fields.
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [unitsPerPack, setUnitsPerPack] = useState("");
  const [weightGrams, setWeightGrams] = useState("");
  const [expiryTracked, setExpiryTracked] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [hasVariants, setHasVariants] = useState(false);
  const [attrNames, setAttrNames] = useState<string[]>([]);
  const [draftVariants, setDraftVariants] = useState<VariantDraft[]>([]);

  // Add-variant dialog.
  const [variantOpen, setVariantOpen] = useState(false);
  const [variantFor, setVariantFor] = useState<Product | null>(null);

  function openNew() {
    setEditing(null);
    setName("");
    setCategory("");
    setSku("");
    setBarcode("");
    setThreshold("5");
    setUnitsPerPack("");
    setExpiryTracked(false);
    setImageUrl("");
    setHasVariants(false);
    setAttrNames([]);
    setDraftVariants([emptyDraft(0)]);
    setOpen(true);
  }
  function openEdit(p: Product) {
    setEditing(p);
    setName(p.name);
    setCategory(p.category ?? "");
    setSku(p.sku ?? "");
    setBarcode(p.barcode ?? "");
    setThreshold(String(p.lowStockThreshold));
    setUnitsPerPack(p.unitsPerPack ? String(p.unitsPerPack) : "");
    setWeightGrams(p.weightGrams != null ? String(p.weightGrams) : "");
    setExpiryTracked(p.expiryTracked);
    setImageUrl(p.imageUrl ?? "");
    const names = p.attributeNames ?? [];
    setAttrNames(names);
    setHasVariants(names.length > 0);
    setDraftVariants(
      p.variants.length
        ? p.variants.map((v) => draftFromVariant(v, names))
        : [emptyDraft(names.length)],
    );
    setOpen(true);
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uri = await fileToDataUri(file);
    if (uri == null) {
      e.target.value = "";
      return;
    }
    setImageUrl(uri);
  }

  // ── Attribute-name column management ──────────────────────────────
  function addAttrName() {
    setAttrNames((n) => [...n, ""]);
    setDraftVariants((rows) => rows.map((r) => ({ ...r, values: [...r.values, ""] })));
  }
  function renameAttr(i: number, value: string) {
    setAttrNames((n) => n.map((x, j) => (j === i ? value : x)));
  }
  function removeAttr(i: number) {
    setAttrNames((n) => n.filter((_, j) => j !== i));
    setDraftVariants((rows) => rows.map((r) => ({ ...r, values: r.values.filter((_, j) => j !== i) })));
  }

  // ── Variant-row management ────────────────────────────────────────
  function updateDraft(i: number, patch: Partial<VariantDraft>) {
    setDraftVariants((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function updateDraftValue(i: number, attrIndex: number, value: string) {
    setDraftVariants((rows) =>
      rows.map((r, j) =>
        j === i ? { ...r, values: r.values.map((v, k) => (k === attrIndex ? value : v)) } : r,
      ),
    );
  }
  async function onPickDraftImage(i: number, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uri = await fileToDataUri(file);
    if (uri == null) {
      e.target.value = "";
      return;
    }
    updateDraft(i, { imageUrl: uri });
  }

  async function onCreateCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setCategorySaving(true);
    const res = await createProductCategory(slug, newCategoryName.trim());
    setCategorySaving(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (!categoryList.includes(res.name)) {
      setCategoryList([...categoryList, res.name].sort());
    }
    setCategory(res.name);
    setCategoryDialogOpen(false);
    toast.success("Category added");
  }

  async function onSubmitProduct(e: React.FormEvent) {
    e.preventDefault();

    const names = hasVariants ? attrNames.map((n) => n.trim()).filter(Boolean) : [];
    if (hasVariants && names.length === 0) {
      toast.error("Add at least one attribute (e.g. Size) or turn off variants");
      return;
    }
    // Keep only rows that carry a value for at least one attribute; a simple
    // product always keeps its single default row.
    const rows = hasVariants
      ? draftVariants.filter((d) => d.values.some((v) => v.trim()))
      : draftVariants.slice(0, 1);
    if (hasVariants && rows.length === 0) {
      toast.error("Add at least one variant, or turn off variants");
      return;
    }

    setLoading(true);
    const fd = new FormData();
    fd.set("name", name);
    fd.set("category", category);
    fd.set("sku", sku);
    fd.set("barcode", barcode);
    fd.set("lowStockThreshold", threshold);
    fd.set("unitsPerPack", unitsPerPack);
    fd.set("weightGrams", weightGrams);
    fd.set("expiryTracked", expiryTracked ? "true" : "false");
    fd.set("imageUrl", imageUrl);
    fd.set("attributeNames", JSON.stringify(names));
    fd.set("variants", JSON.stringify(rows.map((d) => draftPayload(d, names))));

    const res = editing
      ? await updateProduct(slug, editing.id, fd)
      : await createProduct(slug, fd);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(editing ? "Product updated" : "Product added");
    setOpen(false);
    router.refresh();
  }

  async function onDeleteProduct(p: Product) {
    const ok = await confirmDialog({
      title: "Delete product?",
      description: `"${p.name}" and all its variants and purchase history will be permanently deleted.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteProduct(slug, p.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Product deleted");
    router.refresh();
  }

  async function onDeleteVariant(v: Variant) {
    const ok = await confirmDialog({
      title: "Delete variant?",
      description: "This variant option will be removed from the product.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteVariant(slug, v.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Variant deleted");
    router.refresh();
  }

  // Quick "+ Variant" dialog state (adds one variant to an existing product).
  const [quickDraft, setQuickDraft] = useState<VariantDraft>(emptyDraft(0));
  function openAddVariant(p: Product) {
    setVariantFor(p);
    setQuickDraft(emptyDraft(p.attributeNames.length));
    setVariantOpen(true);
  }
  async function onAddVariant(e: React.FormEvent) {
    e.preventDefault();
    if (!variantFor) return;
    const names = variantFor.attributeNames;
    const fd = new FormData();
    fd.set("variant", JSON.stringify(draftPayload(quickDraft, names)));
    const res = await addVariant(slug, variantFor.id, fd);
    if (!res.ok) return toast.error(res.error);
    toast.success("Variant added");
    setVariantOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search products…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-xs"
          />
          {bar}
        </div>
        {perms.canAdd && (
          <div className="flex items-center gap-2">
            <ProductImportDialog slug={slug} />
            <Button size="sm" onClick={openNew}>
              + Add product
            </Button>
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Package}
          title={active > 0 ? "No products match these filters" : "No products found"}
          description={
            active === 0 && perms.canAdd
              ? "Add your first product to start tracking stock."
              : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {shown.map((p) => (
            <div key={p.id} className="rounded-lg border p-3 sm:p-4">
              <div className="flex items-start gap-3 sm:gap-4">
                {p.imageUrl ? (
                  <Image
                    src={p.imageUrl}
                    alt={p.name}
                    width={56}
                    height={56}
                    className="h-12 w-12 shrink-0 rounded-md object-cover sm:h-14 sm:w-14"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground sm:h-14 sm:w-14">
                    No img
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/${slug}/products/${p.id}`}
                      className="font-medium underline-offset-4 wrap-break-word hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.category && <Badge variant="secondary">{p.category}</Badge>}
                    {p.expiryTracked && <Badge variant="outline">Expiry tracked</Badge>}
                  </div>
                  <div className="text-xs wrap-break-word text-muted-foreground">
                    {p.sku && <>SKU {p.sku} · </>}
                    {p.barcode && <>Barcode {p.barcode} · </>}
                    Low-stock ≤ {p.lowStockThreshold} ·{" "}
                    <Link
                      href={`/${slug}/products/${p.id}`}
                      className="underline underline-offset-4"
                    >
                      Sales &amp; profit
                    </Link>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.variants.map((v) => {
                      const threshold = v.lowStockThreshold ?? p.lowStockThreshold;
                      const low = v.stock <= threshold;
                      return (
                        <span
                          key={v.id}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                        >
                          <span className="font-medium">{variantChip(v.attributes)}</span>
                          {v.salePrice != null && (
                            <span className="text-muted-foreground">· {money(v.salePrice)}</span>
                          )}
                          <span className={low ? "font-semibold text-destructive" : ""}>
                            · {formatStock(v.stock, p.unitsPerPack)} in stock
                          </span>
                          {perms.canEdit && (
                            <button
                              type="button"
                              onClick={() => onDeleteVariant(v)}
                              className="ml-1 text-muted-foreground hover:text-destructive"
                              aria-label="Delete variant"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      );
                    })}
                    {p.variants.length === 0 && (
                      <span className="text-xs text-muted-foreground">No variants</span>
                    )}
                  </div>
                </div>
                {/* Desktop: action column beside the content */}
                {perms.canEdit && (
                  <div className="hidden shrink-0 flex-col gap-1 sm:flex">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    {p.attributeNames.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => openAddVariant(p)}>
                        + Variant
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => onDeleteProduct(p)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
              {/* Mobile: action row under the content, full card width */}
              {perms.canEdit && (
                <div className="mt-3 flex gap-1 border-t pt-2 sm:hidden">
                  <Button variant="ghost" size="sm" className="flex-1" onClick={() => openEdit(p)}>
                    Edit
                  </Button>
                  {p.attributeNames.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1"
                      onClick={() => openAddVariant(p)}
                    >
                      + Variant
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    onClick={() => onDeleteProduct(p)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Product create/edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit product" : "Add product"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmitProduct} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="p-name">Name</Label>
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={category}
                  onValueChange={(v) => {
                    if (v === ADD_NEW_CATEGORY) {
                      setNewCategoryName("");
                      setCategoryDialogOpen(true);
                      return;
                    }
                    setCategory(v ?? "");
                  }}
                  items={[
                    ...categoryList.map((c) => ({ value: c, label: c })),
                    { value: ADD_NEW_CATEGORY, label: "+ Add new category…" },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryList.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                    <SelectItem value={ADD_NEW_CATEGORY}>+ Add new category…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-threshold">Low-stock threshold</Label>
                <Input
                  id="p-threshold"
                  type="number"
                  min={0}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </div>
              <SkuBuilder
                // Remounts per dialog opening, so the suggested number and
                // prefix are recomputed for each product rather than carried
                // over from the last one.
                key={editing?.id ?? "new"}
                value={sku}
                onChange={setSku}
                products={products}
                category={category}
                ownSku={editing?.sku}
                // Three controls plus a preview don't fit a half-width cell.
                className="sm:col-span-2"
              />
              <div className="space-y-2">
                <Label htmlFor="p-barcode">Barcode</Label>
                <Input id="p-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-weight">Shipping weight (grams)</Label>
                <Input
                  id="p-weight"
                  type="number"
                  min={0}
                  placeholder="e.g. 450"
                  value={weightGrams}
                  onChange={(e) => setWeightGrams(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  One piece, packed. The order form totals these to weigh the parcel — and
                  couriers charge for every kilo above their limit.
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="p-upp">Units per pack</Label>
                <Input
                  id="p-upp"
                  type="number"
                  min={2}
                  placeholder="e.g. 10 — leave blank if not sold in packs"
                  value={unitsPerPack}
                  onChange={(e) => setUnitsPerPack(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Stock is always counted in single pieces; this enables buying/selling by the
                  packet with automatic conversion.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="p-expiry"
                checked={expiryTracked}
                onCheckedChange={(v) => setExpiryTracked(v === true)}
              />
              <Label htmlFor="p-expiry">Track expiry dates</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-image">Image</Label>
              <Input id="p-image" type="file" accept="image/*" onChange={onPickImage} />
              {imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt="preview" className="h-20 w-20 rounded-md object-cover" />
              )}
            </div>

            <div className="flex items-center gap-2 border-t pt-4">
              <Checkbox
                id="p-hasvariants"
                checked={hasVariants}
                onCheckedChange={(v) => {
                  const on = v === true;
                  setHasVariants(on);
                  if (on) {
                    // Seed sensible defaults when switching a product to variable.
                    setAttrNames((n) => (n.length ? n : ["Size", "Color"]));
                    setDraftVariants((rows) => {
                      const count = attrNames.length || 2;
                      return rows.length ? rows.map((r) => ({
                        ...r,
                        values: Array.from({ length: count }, (_, i) => r.values[i] ?? ""),
                      })) : [emptyDraft(count)];
                    });
                  }
                }}
              />
              <Label htmlFor="p-hasvariants">
                This product has multiple variants (size / color / etc.)
              </Label>
            </div>

            {!hasVariants ? (
              // Simple product: pricing for its single (default) variant.
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="p-sale">Selling price</Label>
                  <Input
                    id="p-sale"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="৳"
                    value={draftVariants[0]?.salePrice ?? ""}
                    onChange={(e) => updateDraft(0, { salePrice: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-cost">Cost</Label>
                  <Input
                    id="p-cost"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="৳"
                    value={draftVariants[0]?.unitCost ?? ""}
                    onChange={(e) => updateDraft(0, { unitCost: e.target.value })}
                  />
                </div>
                <p className="col-span-2 text-xs text-muted-foreground">
                  Used as the default price when buying or selling this product. Leave blank to fill
                  it in at purchase/sale time.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Attribute-name columns */}
                <div className="space-y-2">
                  <Label>Attributes</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {attrNames.map((n, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <Input
                          className="h-8 w-28"
                          placeholder={`Attribute ${i + 1}`}
                          value={n}
                          onChange={(e) => renameAttr(i, e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => removeAttr(i)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label="Remove attribute"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" onClick={addAttrName}>
                      + Attribute
                    </Button>
                  </div>
                </div>

                {/* Per-variant rows */}
                <Label>Variants</Label>
                {draftVariants.map((d, i) => (
                  <div key={i} className="space-y-2 rounded-md border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
                        {attrNames.map((n, ai) => (
                          <div key={ai} className="space-y-1">
                            <Label className="text-xs text-muted-foreground">{n || `Attr ${ai + 1}`}</Label>
                            <Input
                              className="h-8"
                              value={d.values[ai] ?? ""}
                              onChange={(e) => updateDraftValue(i, ai, e.target.value)}
                            />
                          </div>
                        ))}
                      </div>
                      {draftVariants.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setDraftVariants((rows) => rows.filter((_, j) => j !== i))}
                          className="mt-6 text-muted-foreground hover:text-destructive"
                          aria-label="Remove variant"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Selling price</Label>
                        <Input
                          className="h-8"
                          type="number"
                          min={0}
                          step="0.01"
                          value={d.salePrice}
                          onChange={(e) => updateDraft(i, { salePrice: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Cost</Label>
                        <Input
                          className="h-8"
                          type="number"
                          min={0}
                          step="0.01"
                          value={d.unitCost}
                          onChange={(e) => updateDraft(i, { unitCost: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">SKU</Label>
                        <Input
                          className="h-8"
                          value={d.sku}
                          onChange={(e) => updateDraft(i, { sku: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Barcode</Label>
                        <Input
                          className="h-8"
                          value={d.barcode}
                          onChange={(e) => updateDraft(i, { barcode: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Low-stock ≤</Label>
                        <Input
                          className="h-8"
                          type="number"
                          min={0}
                          placeholder={String(threshold)}
                          value={d.lowStockThreshold}
                          onChange={(e) => updateDraft(i, { lowStockThreshold: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-3">
                        <Label className="text-xs text-muted-foreground">Short description</Label>
                        <Input
                          className="h-8"
                          value={d.description}
                          onChange={(e) => updateDraft(i, { description: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs text-muted-foreground">Image</Label>
                        <Input
                          className="h-8"
                          type="file"
                          accept="image/*"
                          onChange={(e) => onPickDraftImage(i, e)}
                        />
                      </div>
                      {d.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={d.imageUrl}
                          alt="variant"
                          className="h-12 w-12 shrink-0 rounded-md object-cover"
                        />
                      )}
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraftVariants((rows) => [...rows, emptyDraft(attrNames.length)])
                  }
                >
                  + Add variant
                </Button>
              </div>
            )}

            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Quick add-variant dialog (existing product) */}
      <Dialog open={variantOpen} onOpenChange={setVariantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add variant to {variantFor?.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onAddVariant} className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(variantFor?.attributeNames ?? []).map((n, ai) => (
                <div key={ai} className="space-y-1">
                  <Label className="text-xs">{n}</Label>
                  <Input
                    value={quickDraft.values[ai] ?? ""}
                    onChange={(e) =>
                      setQuickDraft((q) => ({
                        ...q,
                        values: q.values.map((v, k) => (k === ai ? e.target.value : v)),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Selling price</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={quickDraft.salePrice}
                  onChange={(e) => setQuickDraft((q) => ({ ...q, salePrice: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Cost</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={quickDraft.unitCost}
                  onChange={(e) => setQuickDraft((q) => ({ ...q, unitCost: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">SKU</Label>
                <Input
                  value={quickDraft.sku}
                  onChange={(e) => setQuickDraft((q) => ({ ...q, sku: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Barcode</Label>
                <Input
                  value={quickDraft.barcode}
                  onChange={(e) => setQuickDraft((q) => ({ ...q, barcode: e.target.value }))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit">Add variant</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add-category dialog */}
      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add category</DialogTitle>
          </DialogHeader>
          <form onSubmit={onCreateCategory} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-cat-name">Name</Label>
              <Input
                id="new-cat-name"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={categorySaving}>
                {categorySaving ? "Saving…" : "Add category"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
