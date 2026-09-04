import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { PrintSheetView } from "@/components/ui/print-sheet-view";
import { GiftTag, type GiftTagQr } from "@/components/sales/gift-tag";

/**
 * Printable gift tags, six to an A4 portrait sheet — dropped into a parcel
 * whenever an order gets a free gift. Every tag is identical (shop copy and
 * contact QR codes, no order data), so unlike the order-forms page this
 * takes no selection and needs no ids — it's always just "give me a sheet".
 */

const QR_LINKS: Record<keyof GiftTagQr, string> = {
  site: "https://gedushop.com",
  facebook: "https://facebook.com/gedushop",
  // The label reads "WhatsApp or call", but WhatsApp is the action a scanned
  // QR can actually jump into — a tel: link just opens the dialer, which
  // isn't the "or call" case, but wa.me covers texting AND lets the customer
  // start a call from inside the chat too.
  whatsapp: "https://wa.me/8801552958606",
};

async function buildQr(): Promise<GiftTagQr> {
  const [site, facebook, whatsapp] = await Promise.all([
    QRCode.toDataURL(QR_LINKS.site, { margin: 0, color: { dark: "#2f2a5c", light: "#ffffff" } }),
    QRCode.toDataURL(QR_LINKS.facebook, { margin: 0, color: { dark: "#2f2a5c", light: "#ffffff" } }),
    QRCode.toDataURL(QR_LINKS.whatsapp, { margin: 0, color: { dark: "#2f2a5c", light: "#ffffff" } }),
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

  const qr = await buildQr();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <div className="text-sm text-muted-foreground">Gift tags · 6 per A4 sheet</div>
      </div>

      <PrintSheetView filename="gedushop-gift-tags" widthMm={210} heightMm={297}>
        <div data-sheet-frame>
          <div data-sheet data-density="6">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} data-slot>
                <GiftTag qr={qr} />
              </div>
            ))}
          </div>
        </div>
      </PrintSheetView>
    </div>
  );
}
