import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PrintSheetView } from "@/components/ui/print-sheet-view";
import { LeafletPanel, type LeafletQr } from "@/components/sales/leaflet-panel";
import { resolvePrintProfile, type ResolvedPrintProfile } from "@/lib/print-profile";

/**
 * The shop's leaflet, four to an A4 portrait sheet. Every panel is identical
 * (no order data), so there is no selection — and every word and link on it is
 * the workspace's own (Settings → Appearance → Printed extras).
 */

async function buildQr(profile: ResolvedPrintProfile): Promise<LeafletQr> {
  const opts = { margin: 0, color: { dark: "#4f4274", light: "#ffffff" } };
  const [site, facebook, whatsapp] = await Promise.all([
    profile.website ? QRCode.toDataURL(profile.website.url, opts) : undefined,
    profile.facebook ? QRCode.toDataURL(profile.facebook.url, opts) : undefined,
    profile.whatsapp ? QRCode.toDataURL(profile.whatsapp.url, opts) : undefined,
  ]);
  return { site, facebook, whatsapp };
}

// Border per panel: a right edge on the left column, a bottom edge on the top
// row, nothing past the sheet's own outer edge.
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

  const ws = await prisma.workspace.findUniqueOrThrow({
    where: { id: access.workspaceId },
    select: { name: true, logoUrl: true, websiteUrl: true, printProfile: true },
  });
  const profile = resolvePrintProfile(ws);
  const qr = await buildQr(profile);
  const nothingToLink = !profile.website && !profile.facebook && !profile.whatsapp;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <div className="text-sm text-muted-foreground">Leaflet · 4 per A4 sheet</div>
      </div>

      {nothingToLink ? (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
          This leaflet has no contact QR codes yet. Add your website, Facebook page or WhatsApp
          number under{" "}
          <Link className="underline" href={`/${slug}/settings/appearance`}>
            Settings → Appearance → Printed extras
          </Link>
          .
        </p>
      ) : null}

      <PrintSheetView filename={`${slug}-leaflet-a4-4up`} widthMm={210} heightMm={297}>
        <div data-sheet-frame>
          <div data-sheet style={{ gridTemplateRows: "1fr 1fr" }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} data-slot style={panelBorder(i)}>
                <LeafletPanel qr={qr} profile={profile} />
              </div>
            ))}
          </div>
        </div>
      </PrintSheetView>
    </div>
  );
}
