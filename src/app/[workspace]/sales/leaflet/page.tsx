import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { PrintSheetView } from "@/components/ui/print-sheet-view";
import { LeafletPanel, type LeafletQr } from "@/components/sales/leaflet-panel";

/**
 * Printable promo leaflet, four to an A4 portrait sheet — ported from the
 * shop's existing gedushop-leaflet-a4-4up.pdf so it can be reprinted from
 * the app instead of going back to the source design files. Same as
 * gift-tags: every panel is identical shop copy, no order data, so this
 * takes no selection.
 */

const QR_LINKS: Record<keyof LeafletQr, string> = {
  site: "https://gedushop.com",
  facebook: "https://facebook.com/gedushop",
  whatsapp: "https://wa.me/8801552958606",
};

async function buildQr(): Promise<LeafletQr> {
  const [site, facebook, whatsapp] = await Promise.all([
    QRCode.toDataURL(QR_LINKS.site, { margin: 0, color: { dark: "#4f4274", light: "#ffffff" } }),
    QRCode.toDataURL(QR_LINKS.facebook, { margin: 0, color: { dark: "#4f4274", light: "#ffffff" } }),
    QRCode.toDataURL(QR_LINKS.whatsapp, { margin: 0, color: { dark: "#4f4274", light: "#ffffff" } }),
  ]);
  return { site, facebook, whatsapp };
}

// Border per panel, matching the source design's sheet4.html: a right edge
// on the left column, a bottom edge on the top row, nothing past the sheet's
// own outer edge.
const RULE = "1px solid #cfc7e8";
function panelBorder(i: number): React.CSSProperties {
  return {
    borderRight: i % 2 === 0 ? RULE : undefined,
    borderBottom: i < 2 ? RULE : undefined,
  };
}

export default async function LeafletPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const qr = await buildQr();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <div className="text-sm text-muted-foreground">Leaflet · 4 per A4 sheet</div>
      </div>

      <PrintSheetView filename="gedushop-leaflet-a4-4up" widthMm={210} heightMm={297}>
        <div data-sheet-frame>
          <div data-sheet style={{ gridTemplateRows: "1fr 1fr" }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} data-slot style={panelBorder(i)}>
                <LeafletPanel qr={qr} />
              </div>
            ))}
          </div>
        </div>
      </PrintSheetView>
    </div>
  );
}
