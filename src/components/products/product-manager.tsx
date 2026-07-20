"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  addVariant,
  deleteVariant,
} from "@/server/actions/products";
import { createProductCategory } from "@/server/actions/product-categories";
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
import { Package } from "lucide-react";

const ADD_NEW_CATEGORY = "__add_new__";

type Variant = {
  id: string;
  size: string | null;
  color: string | null;
  sku: string | null;
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
  variants: Variant[];
};
type Perms = { canAdd: boolean; canEdit: boolean };
type VariantDraft = { size: string; color: string; sku: string };

const MAX_IMAGE_BYTES = 1_400_000;
const IMAGE_MAX_DIMENSION = 480; // px, longest side — plenty for a list thumbnail
const IMAGE_QUALITY = 0.72;

/**
 * Downscale + recompress an image client-side before it ever becomes a
 * stored data URI. Product images were being stored at full upload size
 * (up to ~1.4MB each) and fetched in full on every Products/Purchases/Sales
 * page load — with 20+ products that's tens of MB transferred per page view.
 * Shrinking to a 480px JPEG typically lands at 15-60KB regardless of the
 * original file size.
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

function variantText(v: { size: string | null; color: string | null }) {
  return [v.size, v.color].filter(Boolean).join(" / ") || "default";
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

  const shown = products.filter((p) => {
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
  const [expiryTracked, setExpiryTracked] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [hasVariants, setHasVariants] = useState(false);
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
    setExpiryTracked(false);
    setImageUrl("");
    setHasVariants(false);
    setDraftVariants([{ size: "", color: "", sku: "" }]);
    setOpen(true);
  }
  function openEdit(p: Product) {
    setEditing(p);
    setName(p.name);
    setCategory(p.category ?? "");
    setSku(p.sku ?? "");
    setBarcode(p.barcode ?? "");
    setThreshold(String(p.lowStockThreshold));
    setExpiryTracked(p.expiryTracked);
    setImageUrl(p.imageUrl ?? "");
    setDraftVariants([]);
    setOpen(true);
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image too large (max ~1.4MB)");
      e.target.value = "";
      return;
    }
    try {
      setImageUrl(await downscaleImage(file));
    } catch {
      toast.error("Couldn't process that image");
    }
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
    setLoading(true);
    const fd = new FormData();
    fd.set("name", name);
    fd.set("category", category);
    fd.set("sku", sku);
    fd.set("barcode", barcode);
    fd.set("lowStockThreshold", threshold);
    fd.set("expiryTracked", expiryTracked ? "true" : "false");
    fd.set("imageUrl", imageUrl);
    // Only send variants when the user opted into them; otherwise the server
    // creates a single default variant automatically.
    fd.set("variants", JSON.stringify(editing || !hasVariants ? [] : draftVariants));
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
    if (!confirm(`Delete "${p.name}" and all its variants/purchases?`)) return;
    const res = await deleteProduct(slug, p.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Product deleted");
    router.refresh();
  }

  async function onDeleteVariant(v: Variant) {
    if (!confirm("Delete this variant?")) return;
    const res = await deleteVariant(slug, v.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Variant deleted");
    router.refresh();
  }

  async function onAddVariant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!variantFor) return;
    const res = await addVariant(slug, variantFor.id, new FormData(e.currentTarget));
    if (!res.ok) return toast.error(res.error);
    toast.success("Variant added");
    setVariantOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Input
          placeholder="Search products…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        {perms.canAdd && (
          <Button size="sm" onClick={openNew}>
            + Add product
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products found"
          description={perms.canAdd ? "Add your first product to start tracking stock." : undefined}
        />
      ) : (
        <div className="space-y-3">
          {shown.map((p) => (
            <div key={p.id} className="rounded-lg border p-4">
              <div className="flex items-start gap-4">
                {p.imageUrl ? (
                  <Image
                    src={p.imageUrl}
                    alt={p.name}
                    width={56}
                    height={56}
                    className="h-14 w-14 rounded-md object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
                    No img
                  </div>
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.category && <Badge variant="secondary">{p.category}</Badge>}
                    {p.expiryTracked && <Badge variant="outline">Expiry tracked</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.sku && <>SKU {p.sku} · </>}
                    {p.barcode && <>Barcode {p.barcode} · </>}
                    Low-stock ≤ {p.lowStockThreshold}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.variants.map((v) => {
                      const low = v.stock <= p.lowStockThreshold;
                      return (
                        <span
                          key={v.id}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                        >
                          {variantText(v)}
                          <span className={low ? "font-semibold text-destructive" : ""}>
                            · {v.stock} in stock
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
                {perms.canEdit && (
                  <div className="flex flex-col gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setVariantFor(p);
                        setVariantOpen(true);
                      }}
                    >
                      + Variant
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onDeleteProduct(p)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Product create/edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit product" : "Add product"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmitProduct} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="p-name">Name</Label>
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              <div className="space-y-2">
                <Label htmlFor="p-sku">SKU</Label>
                <Input id="p-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-barcode">Barcode</Label>
                <Input id="p-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
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

            {!editing && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="p-hasvariants"
                  checked={hasVariants}
                  onCheckedChange={(v) => {
                    const on = v === true;
                    setHasVariants(on);
                    if (on && draftVariants.length === 0) {
                      setDraftVariants([{ size: "", color: "", sku: "" }]);
                    }
                  }}
                />
                <Label htmlFor="p-hasvariants">
                  This product has variants (size / color)
                </Label>
              </div>
            )}

            {!editing && hasVariants && (
              <div className="space-y-2">
                <Label>Variants (size / color / SKU)</Label>
                {draftVariants.map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      placeholder="Size"
                      value={v.size}
                      onChange={(e) => {
                        const next = [...draftVariants];
                        next[i] = { ...v, size: e.target.value };
                        setDraftVariants(next);
                      }}
                    />
                    <Input
                      placeholder="Color"
                      value={v.color}
                      onChange={(e) => {
                        const next = [...draftVariants];
                        next[i] = { ...v, color: e.target.value };
                        setDraftVariants(next);
                      }}
                    />
                    <Input
                      placeholder="SKU"
                      value={v.sku}
                      onChange={(e) => {
                        const next = [...draftVariants];
                        next[i] = { ...v, sku: e.target.value };
                        setDraftVariants(next);
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDraftVariants(draftVariants.filter((_, j) => j !== i))}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraftVariants([...draftVariants, { size: "", color: "", sku: "" }])}
                >
                  + Add variant row
                </Button>
                <p className="text-xs text-muted-foreground">
                  Add more variants later from the list. Uncheck to sell as a single product.
                </p>
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

      {/* Add-variant dialog */}
      <Dialog open={variantOpen} onOpenChange={setVariantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add variant to {variantFor?.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onAddVariant} className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-2">
                <Label htmlFor="v-size">Size</Label>
                <Input id="v-size" name="size" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="v-color">Color</Label>
                <Input id="v-color" name="color" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="v-sku">SKU</Label>
                <Input id="v-sku" name="sku" />
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
