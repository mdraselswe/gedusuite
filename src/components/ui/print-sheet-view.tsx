"use client";

import { useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Preview + PDF download for a page of printed A4 sheets — order forms,
 * blank forms, gift tags, anything laid out as one or more `[data-sheet]`
 * elements sized in `globals.css`'s "Printed A4 sheets" block.
 *
 * The sheets themselves are server-rendered and passed in as children — this
 * only wraps them in a zoomable preview and turns them into a real PDF.
 *
 * Why an image capture rather than jsPDF's own text(): these sheets are
 * mostly Bangla, and jsPDF draws each codepoint as an isolated glyph with no
 * script shaping, so a matra that has to move in front of its consonant
 * simply doesn't. See the note on DownloadInvoicePdfButton — same reasoning,
 * same fix.
 */

const ZOOMS = [0.4, 0.5, 0.65, 0.8, 1] as const;

export function PrintSheetView({
  children,
  filename,
  /** Sheet size in mm. Defaults to A4 landscape — order forms' original size. */
  widthMm = 297,
  heightMm = 210,
}: {
  children: React.ReactNode;
  filename: string;
  widthMm?: number;
  heightMm?: number;
}) {
  const [zoomIdx, setZoomIdx] = useState(1);
  const [busy, setBusy] = useState(false);
  // While capturing, the sheets must render at their true size: html2canvas
  // measures the live element, so a CSS-scaled preview would be captured at
  // the preview's size and come out blurry or cropped.
  const [capturing, setCapturing] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);

  const zoom = capturing ? 1 : ZOOMS[zoomIdx];
  const orientation = widthMm >= heightMm ? "l" : "p";

  async function onDownload() {
    const area = areaRef.current;
    if (!area) return;
    setBusy(true);
    setCapturing(true);
    try {
      // Two frames: one for React to commit the un-zoomed render, one for the
      // browser to lay it out before html2canvas measures anything.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const html2canvas = (await import("html2canvas-pro")).default;
      const { jsPDF } = await import("jspdf");

      const sheets = Array.from(area.querySelectorAll<HTMLElement>("[data-sheet]"));
      if (sheets.length === 0) return;

      const doc = new jsPDF({ orientation, unit: "mm", format: "a4" });
      for (const [i, sheet] of sheets.entries()) {
        if (i > 0) doc.addPage("a4", orientation);
        const canvas = await html2canvas(sheet, {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
        });
        // Full-bleed: the 0.2in print margin is padding inside the sheet
        // element, so what was previewed is exactly what lands on the page —
        // there's no second margin calculation here to disagree with the CSS.
        doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, widthMm, heightMm);
      }
      doc.save(`${filename}.pdf`);
    } finally {
      setCapturing(false);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Zoom out"
            disabled={zoomIdx === 0}
            onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
          >
            <Minus className="size-4" />
          </Button>
          <span className="w-12 text-center text-sm tabular-nums text-muted-foreground">
            {Math.round(ZOOMS[zoomIdx] * 100)}%
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Zoom in"
            disabled={zoomIdx === ZOOMS.length - 1}
            onClick={() => setZoomIdx((i) => Math.min(ZOOMS.length - 1, i + 1))}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <Button onClick={onDownload} disabled={busy}>
          {busy ? "Preparing…" : "Download PDF"}
        </Button>
      </div>

      <div
        ref={areaRef}
        className="sheet-preview overflow-x-auto print:overflow-visible"
        style={{ "--sheet-zoom": zoom, "--sheet-w": `${widthMm}mm`, "--sheet-h": `${heightMm}mm` } as React.CSSProperties}
      >
        <div className="flex flex-col items-start gap-6 print:gap-0">{children}</div>
      </div>
    </div>
  );
}
