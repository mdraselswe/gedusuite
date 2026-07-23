"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { importProducts } from "@/server/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const EXAMPLE = `[
  {
    "name": "Baby Romper",
    "category": "Baby Clothing",
    "sku": "ROM-001",
    "barcode": "8901234567890",
    "expiryTracked": false,
    "lowStockThreshold": 5,
    "variants": [
      { "size": "0-3M", "color": "Pink" },
      { "size": "3-6M", "color": "Blue", "sku": "ROM-001-36B" }
    ]
  },
  {
    "name": "Baby Wipes 120pcs"
  }
]`;

export function ProductImportDialog({ slug }: { slug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileText(null);
    setCount(null);
    if (!file) return;
    const text = await file.text();
    setFileText(text);
    setFileName(file.name);
    // Cheap local preview count — real validation happens server-side.
    try {
      const arr = JSON.parse(text);
      setCount(Array.isArray(arr) ? arr.length : null);
    } catch {
      setCount(null);
    }
  }

  async function onImport() {
    if (!fileText) return;
    setImporting(true);
    const res = await importProducts(slug, fileText);
    setImporting(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(
      `Imported ${res.created} product${res.created === 1 ? "" : "s"}` +
        (res.skipped.length ? ` — ${res.skipped.length} skipped (already exist)` : ""),
    );
    setOpen(false);
    setFileText(null);
    setCount(null);
    setFileName("");
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Import JSON
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* min-w-0 on the body: DialogContent is a grid, and grid children
            default to min-width:auto — the wide <pre> example was stretching
            the dialog and causing horizontal scroll. */}
        <DialogContent className="max-h-[90vh] overflow-x-hidden overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import products from JSON</DialogTitle>
            <DialogDescription>
              Upload a .json file containing an array of products — every product in the file is
              created automatically. Products whose name already exists are skipped, so re-running
              the same file is safe.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-4">
            <div className="space-y-2 text-sm">
              <p className="font-medium">Format</p>
              <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                <li>
                  <code className="rounded bg-muted px-1">name</code> — required; everything else is
                  optional
                </li>
                <li>
                  <code className="rounded bg-muted px-1">category</code>,{" "}
                  <code className="rounded bg-muted px-1">sku</code>,{" "}
                  <code className="rounded bg-muted px-1">barcode</code> — text
                </li>
                <li>
                  <code className="rounded bg-muted px-1">expiryTracked</code> — true/false (default
                  false)
                </li>
                <li>
                  <code className="rounded bg-muted px-1">lowStockThreshold</code> — number (default
                  5)
                </li>
                <li>
                  <code className="rounded bg-muted px-1">unitsPerPack</code> — number (e.g. 10) for
                  pack-based products; omit otherwise
                </li>
                <li>
                  <code className="rounded bg-muted px-1">variants</code> — list of{" "}
                  <code className="rounded bg-muted px-1">{`{ size, color, sku }`}</code>; omit for a
                  single default variant
                </li>
                <li>New categories are added to the category list automatically. Max 500 per file.</li>
              </ul>
              <p className="font-medium">Example</p>
              <pre className="max-h-56 max-w-full overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {EXAMPLE}
              </pre>
            </div>

            <div className="space-y-2">
              <Input type="file" accept="application/json,.json" onChange={onFile} />
              {fileText && (
                <p className="text-sm text-muted-foreground">
                  {fileName}
                  {count !== null ? ` — ${count} product${count === 1 ? "" : "s"} found` : ""}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button onClick={onImport} disabled={!fileText || importing}>
              {importing ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
