import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { loadResellerList } from "@/lib/reseller-list";
import { formatMoney } from "@/lib/money";
import { formatDhakaDate } from "@/lib/dhaka-time";
import { facebookContact, parsePrintProfile, websiteContact, whatsappContact } from "@/lib/print-profile";
import type { ResellerRow } from "@/lib/reseller-pricing";
import { PrintSheetView } from "@/components/ui/print-sheet-view";

/**
 * The reseller price list as A4 pages, for sending as a PDF.
 *
 * Built only from ResellerRow — the same reseller-safe rows the Google Sheet
 * gets — so nothing about cost or profit can end up in the file. Captured as
 * an image by PrintSheetView because product names are often Bangla, which
 * jsPDF's own text drawing can't shape.
 */

// Page room in millimetres of table. Rows grow with their bands — each
// product lists its own, one per line — so pages are filled by height.
const FIRST_PAGE_MM = 205;
const PAGE_MM = 235;
const CATEGORY_MM = 8;
const ROW_MM = 3;
const BAND_MM = 4.4;

const lineMm = (line: Line) => (line.kind === "category" ? CATEGORY_MM : ROW_MM + BAND_MM * Math.max(1, line.row.bands.length));

type Line = { kind: "category"; name: string } | { kind: "row"; row: ResellerRow; n: number };

function paginate(rows: ResellerRow[]): Line[][] {
  const lines: Line[] = [];
  let last: string | null = null;
  rows.forEach((row, i) => {
    const cat = row.category || "Other";
    if (cat !== last) {
      lines.push({ kind: "category", name: cat });
      last = cat;
    }
    lines.push({ kind: "row", row, n: i + 1 });
  });
  const pages: Line[][] = [];
  let i = 0;
  while (i < lines.length) {
    const room = pages.length === 0 ? FIRST_PAGE_MM : PAGE_MM;
    let page: Line[] = [];
    let used = 0;
    // Always at least one line, however tall, so a page is never empty.
    while (i < lines.length && (page.length === 0 || used + lineMm(lines[i]) <= room)) {
      used += lineMm(lines[i]);
      page.push(lines[i++]);
    }
    // A heading alone at the foot of a page belongs on the next one.
    if (i < lines.length && page.length > 1 && page[page.length - 1].kind === "category") {
      page = page.slice(0, -1);
      i--;
    }
    pages.push(page);
  }
  return pages.length ? pages : [[]];
}

export default async function ResellerPdfPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (
    !can(access.role, "products", "view", access.permissions) ||
    !can(access.role, "reports", "view", access.permissions)
  ) {
    redirect(`/${slug}/products`);
  }

  const [{ settings, resellerRows }, ws] = await Promise.all([
    loadResellerList(access.workspaceId),
    prisma.workspace.findUniqueOrThrow({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true, websiteUrl: true, printProfile: true },
    }),
  ]);
  const pages = paginate(resellerRows);
  const date = formatDhakaDate(new Date());
  const notes = settings.notes.trim();
  const profile = parsePrintProfile(ws.printProfile);
  const contacts = [
    websiteContact(ws.websiteUrl)?.display,
    whatsappContact(profile.whatsapp) && `WhatsApp: ${whatsappContact(profile.whatsapp)!.display}`,
    facebookContact(profile.facebook)?.display,
  ].filter(Boolean);
  const cols = 5;
  const money = (v: number) => formatMoney(v);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/${slug}/products/reseller`} className="text-sm text-muted-foreground underline">
          ← Reseller price list
        </Link>
        <div className="text-sm text-muted-foreground">
          {resellerRows.length} products · {pages.length} page{pages.length === 1 ? "" : "s"} · reseller prices only
        </div>
      </div>

      <PrintSheetView filename={`${slug}-reseller-price-list-${date}`} widthMm={210} heightMm={297}>
        {pages.map((lines, p) => (
          <div key={p} data-sheet-frame>
            <div
              data-sheet
              style={{ display: "flex", flexDirection: "column", padding: "12mm 12mm 10mm", color: "#1f1d3a", fontSize: "9.5pt" }}
            >
              {p === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: "4mm", marginBottom: "5mm" }}>
                  {ws.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={ws.logoUrl} alt="" style={{ height: "14mm", width: "auto" }} />
                  ) : null}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "16pt", fontWeight: 700 }}>{ws.name}</div>
                    <div style={{ fontSize: "11pt" }}>{settings.title}</div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "8.5pt", color: "#5b587a" }}>
                    <div>Prices as of {date}</div>
                    {contacts.map((c) => (
                      <div key={c}>{c}</div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "8.5pt", color: "#5b587a", marginBottom: "3mm" }}>
                  <span>
                    {ws.name} — {settings.title}
                  </span>
                  <span>{date}</span>
                </div>
              )}

              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#eaedfc" }}>
                    <th style={th("left", "6%")}>#</th>
                    <th style={th("left")}>Product</th>
                    <th style={th("left", "14%")}>SKU</th>
                    <th style={th("right", "12%")}>Retail price</th>
                    <th style={th("left", "30%")}>Reseller price</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) =>
                    line.kind === "category" ? (
                      <tr key={`c${i}`}>
                        <td colSpan={cols} style={{ padding: "2.2mm 1.5mm 1mm", fontWeight: 700, color: "#4338ca" }}>
                          {line.name}
                        </td>
                      </tr>
                    ) : (
                      <tr key={line.row.key} style={{ borderBottom: "0.2mm solid #e3e2ef" }}>
                        <td style={td("left")}>{line.n}</td>
                        <td style={td("left")}>
                          <span style={{ fontWeight: 600 }}>{line.row.product}</span>
                          {line.row.variant ? <span style={{ color: "#5b587a" }}> · {line.row.variant}</span> : null}
                        </td>
                        <td style={{ ...td("left"), fontSize: "8pt", color: "#5b587a" }}>{line.row.sku}</td>
                        <td style={{ ...td("right"), color: "#5b587a" }}>{money(line.row.retail)}</td>
                        <td style={td("left")}>
                          {line.row.bands.map((b) => (
                            <div key={b.label} style={{ display: "flex", justifyContent: "space-between", gap: "3mm" }}>
                              <span style={{ color: "#5b587a" }}>{b.label}</span>
                              <span style={{ fontWeight: 700 }}>{money(b.price)}</span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              {resellerRows.length === 0 ? (
                <p style={{ marginTop: "6mm", color: "#5b587a" }}>No products on the list yet.</p>
              ) : null}

              <div style={{ marginTop: "auto", paddingTop: "4mm", fontSize: "8pt", color: "#5b587a" }}>
                {p === pages.length - 1 ? (
                  <div style={{ marginBottom: "2mm" }}>
                    Retail price is the lowest price the product may be resold at.
                    {notes ? (
                      <div style={{ marginTop: "2mm", whiteSpace: "pre-line", color: "#1f1d3a", fontSize: "8.5pt" }}>
                        {notes}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div style={{ textAlign: "right" }}>
                  Page {p + 1} of {pages.length}
                </div>
              </div>
            </div>
          </div>
        ))}
      </PrintSheetView>
    </div>
  );
}

function th(align: "left" | "right", width?: string): React.CSSProperties {
  return { textAlign: align, padding: "1.6mm 1.5mm", fontWeight: 700, fontSize: "8.5pt", width };
}

function td(align: "left" | "right"): React.CSSProperties {
  return { textAlign: align, padding: "1.3mm 1.5mm", verticalAlign: "top" };
}
