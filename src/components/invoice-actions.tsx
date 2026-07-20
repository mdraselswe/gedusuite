"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Downloads a clean, real PDF file directly — no browser print dialog, so
 * none of its injected header/footer (URL, date, page number) ever appears.
 *
 * Renders as an image rather than vector text on purpose: jsPDF's text()
 * draws each Unicode codepoint as an isolated glyph with no script shaping
 * (no conjunct/ligature formation, no matra reordering), which is fine for
 * Latin but corrupts Bangla — e.g. a vowel sign that has to visually move in
 * front of its consonant just doesn't. The browser's own renderer already
 * shapes Bangla correctly on screen, so capturing that (via html2canvas-pro,
 * which — unlike the original html2canvas — understands the oklch/lab CSS
 * this app's theme uses) and embedding the result as an image sidesteps the
 * whole problem instead of reimplementing text shaping.
 */
export function DownloadInvoicePdfButton({
  targetId,
  filename,
}: {
  targetId: string;
  filename: string;
}) {
  const [busy, setBusy] = useState(false);

  async function onDownload() {
    const el = document.getElementById(targetId);
    if (!el) return;
    setBusy(true);

    // The invoice should always download in light colors, regardless of
    // whether the app itself is currently in dark mode — force it off for
    // the capture window only, then restore whatever the user had.
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    if (wasDark) root.classList.remove("dark");

    try {
      const html2canvas = (await import("html2canvas-pro")).default;
      const { jsPDF } = await import("jspdf");

      const canvas = await html2canvas(el, { scale: 2, useCORS: true });
      const imgData = canvas.toDataURL("image/png");

      // Custom page size matching the captured content's own aspect ratio —
      // the whole invoice fits on one page exactly, no cropping/pagination math.
      const doc = new jsPDF({
        orientation: canvas.width > canvas.height ? "l" : "p",
        unit: "px",
        format: [canvas.width, canvas.height],
      });
      doc.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
      doc.save(`${filename}.pdf`);
    } finally {
      if (wasDark) root.classList.add("dark");
      setBusy(false);
    }
  }

  return (
    <Button onClick={onDownload} disabled={busy} className="print:hidden">
      {busy ? "Preparing…" : "Download PDF"}
    </Button>
  );
}
