import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PrintSheetView } from "@/components/ui/print-sheet-view";
import { GiftTag, type GiftTagQr } from "@/components/sales/gift-tag";
import { resolvePrintProfile, type ResolvedPrintProfile } from "@/lib/print-profile";

/**
 * Printable gift tags, six to an A4 portrait sheet — dropped into a parcel
 * whenever an order gets a free gift. Every tag is identical (the shop's own
 * wording and contact QR codes, no order data), so this takes no selection.
 *
 * Everything on the tag comes from the workspace's profile (Settings →
 * Appearance → Printed extras); a channel the shop has not filled in is left
 * off rather than faked.
 */

async function buildQr(profile: ResolvedPrintProfile): Promise<GiftTagQr> {
  const opts = { margin: 0, color: { dark: "#2f2a5c", light: "#ffffff" } };
  const [site, facebook, whatsapp] = await Promise.all([
    profile.website ? QRCode.toDataURL(profile.website.url, opts) : undefined,
    profile.facebook ? QRCode.toDataURL(profile.facebook.url, opts) : undefined,
    profile.whatsapp ? QRCode.toDataURL(profile.whatsapp.url, opts) : undefined,
  ]);
  return { site, facebook, whatsapp };
}

export default async function GiftTagsPage({
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
        <div className="text-sm text-muted-foreground">Gift tags · 6 per A4 sheet</div>
      </div>

      {nothingToLink ? (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
          These tags have no contact QR codes yet. Add your website, Facebook page or WhatsApp
          number under{" "}
          <Link className="underline" href={`/${slug}/settings/appearance`}>
            Settings → Appearance → Printed extras
          </Link>
          .
        </p>
      ) : null}

      <PrintSheetView filename={`${slug}-gift-tags`} widthMm={210} heightMm={297}>
        <div data-sheet-frame>
          <div data-sheet data-density="6">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} data-slot>
                <GiftTag qr={qr} profile={profile} />
              </div>
            ))}
          </div>
        </div>
      </PrintSheetView>
    </div>
  );
}
