"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateWorkspaceLogo } from "@/server/actions/workspace";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LOGO_MAX_DIMENSION = 320; // px, longest side — sharp at every size it's shown

/**
 * Downscale client-side before it becomes a stored data URI, same reasoning
 * as product images (see product-manager.tsx): full-resolution uploads would
 * bloat every page that renders the logo (nav header, on every navigation).
 * PNG, not JPEG — logos are commonly transparent, JPEG would flatten that to
 * a solid (usually wrong-looking) background.
 */
function downscaleLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("Invalid image"));
      img.onload = () => {
        const scale = Math.min(1, LOGO_MAX_DIMENSION / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unsupported"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function BrandingForm({
  slug,
  initialLogoUrl,
}: {
  slug: string;
  initialLogoUrl: string | null;
}) {
  const router = useRouter();
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl);
  const [saving, setSaving] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    try {
      const dataUrl = await downscaleLogo(file);
      setSaving(true);
      const res = await updateWorkspaceLogo(slug, dataUrl);
      setSaving(false);
      if (!res.ok) return toast.error(res.error);
      setLogoUrl(dataUrl);
      toast.success("Logo updated");
      router.refresh();
    } catch {
      setSaving(false);
      toast.error("Couldn't read that image");
    }
  }

  async function onRemove() {
    setSaving(true);
    const res = await updateWorkspaceLogo(slug, null);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    setLogoUrl(null);
    toast.success("Logo removed");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Brand logo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Shown in the sidebar/header and on invoices and report PDFs, at a standard size.
        </p>
        <div className="flex items-center gap-4">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo preview" className="max-h-14 max-w-14 object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">None</span>
            )}
          </div>
          <div className="flex gap-2">
            <Label
              htmlFor="logo-upload"
              className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input bg-transparent px-3 text-sm font-medium hover:bg-muted"
            >
              {saving ? "Saving…" : logoUrl ? "Replace" : "Upload"}
            </Label>
            <input
              id="logo-upload"
              type="file"
              accept="image/*"
              className="hidden"
              disabled={saving}
              onChange={onFile}
            />
            {logoUrl && (
              <Button type="button" variant="outline" onClick={onRemove} disabled={saving}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
