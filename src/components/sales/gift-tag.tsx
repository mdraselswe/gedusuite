/**
 * One gift tag — a small thank-you card slipped in with a free gift item,
 * six to an A4 portrait sheet (see gift-tags/page.tsx). Unlike OrderFormSlip,
 * every tag on the sheet is identical: there's no per-order data here, just
 * the shop's own copy and contact QR codes, so this takes no order prop.
 */

import type { ResolvedPrintProfile } from "@/lib/print-profile";

export type GiftTagQr = {
  /** data: URL PNGs, generated once per print run — see gift-tags/page.tsx.
   *  A channel the shop does not have is simply absent. */
  site?: string;
  facebook?: string;
  whatsapp?: string;
};

/**
 * Print colours, fixed rather than themed — same reasoning as OrderFormSlip:
 * this is captured to an image for the PDF, where the app's light/dark
 * tokens mean nothing. Reused verbatim from OrderFormSlip so a gift tag and
 * a delivery form printed the same week look like the same shop's paperwork.
 */
const INK = "#2f2a5c";
const ACCENT = "#e8544f";
const RULE = "#9b96c0";
const MUTED = "#6b6785";
const BODY = "#241f38";

const FOOT_ROWS: { key: keyof GiftTagQr; icon: React.ReactNode; label: string }[] = [
  {
    key: "site",
    icon: (
      <svg viewBox="0 0 24 24" className="size-[3.2mm] shrink-0" style={{ fill: INK }}>
        <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 6h-3.2a15.7 15.7 0 00-1.42-4.2A8.03 8.03 0 0118.93 8zM12 4.06c.9 1.16 1.63 2.5 2.1 3.94H9.9c.47-1.44 1.2-2.78 2.1-3.94zM4.26 14a8.15 8.15 0 010-4h3.68a16.7 16.7 0 000 4H4.26zm.81 2h3.2c.32 1.5.79 2.9 1.42 4.2A8.03 8.03 0 015.07 16zm3.2-8H5.07a8.03 8.03 0 014.62-4.2A15.7 15.7 0 008.27 8zM12 19.94c-.9-1.16-1.63-2.5-2.1-3.94h4.2c-.47 1.44-1.2 2.78-2.1 3.94zM14.45 14H9.55a14.7 14.7 0 010-4h4.9a14.7 14.7 0 010 4zm.2 5.2c.63-1.3 1.1-2.7 1.42-4.2h3.2a8.03 8.03 0 01-4.62 4.2zM16.06 14a16.7 16.7 0 000-4h3.68a8.15 8.15 0 010 4h-3.68z" />
      </svg>
    ),
    label: "ওয়েবসাইটে অর্ডার",
  },
  {
    key: "facebook",
    icon: (
      <svg viewBox="0 0 24 24" className="size-[3.2mm] shrink-0" style={{ fill: INK }}>
        <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.91h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94z" />
      </svg>
    ),
    label: "ফেসবুক পেজে ইনবক্স",
  },
  {
    key: "whatsapp",
    icon: (
      <svg viewBox="0 0 24 24" className="size-[3.2mm] shrink-0" style={{ fill: INK }}>
        <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 011 1V20a1 1 0 01-1 1C10.61 21 3 13.39 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.24.2 2.45.57 3.57a1 1 0 01-.25 1.02l-2.2 2.2z" />
      </svg>
    ),
    label: "হোয়াটসঅ্যাপ বা কল",
  },
];

export function GiftTag({ qr, profile }: { qr: GiftTagQr; profile: ResolvedPrintProfile }) {
  const links: Record<keyof GiftTagQr, string | undefined> = {
    site: profile.website?.display,
    facebook: profile.facebook?.display,
    whatsapp: profile.whatsapp?.display,
  };
  const rows = FOOT_ROWS.filter((r) => qr[r.key] && links[r.key]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden px-[6mm] pt-[7mm] pb-[5mm]" style={{ color: BODY }}>
      {profile.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={profile.logoUrl} alt={profile.shopName} className="mx-auto mb-[4mm] block h-[12mm] w-auto max-w-full object-contain" />
      ) : (
        <div className="mx-auto mb-[4mm] text-center text-[15px] font-bold" style={{ color: INK }}>
          {profile.shopName}
        </div>
      )}

      <p className="text-center text-[10px] leading-[1.65]">{profile.giftLead}</p>

      {profile.giftQuote ? (
        <p
          className="mt-[5mm] text-center text-[15px] leading-[1.4] font-semibold before:content-['\201C'] after:content-['\201D']"
          style={{ color: ACCENT }}
        >
          {profile.giftQuote}
        </p>
      ) : null}

      <p className="mt-[5mm] text-center text-[10px] leading-[1.7]">{profile.giftThanks}</p>

      <p className="mt-[5.5mm] text-center text-[12.5px] leading-[1.45] font-semibold" style={{ color: INK }}>
        {profile.giftClosing}
      </p>

      <div className="mt-auto pt-[4mm] pb-[3mm] text-center text-[12px]" style={{ color: RULE }}>
        ✦
      </div>

      {rows.length > 0 ? (
        <div className="pt-[3mm]" style={{ borderTop: "0.35mm solid #ece7f7" }}>
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-[2.2mm] py-[1mm]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr[row.key]} alt="" className="size-[10mm] shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-[1.1mm] text-[6.8px] whitespace-nowrap" style={{ color: MUTED }}>
                  {row.icon}
                  <span>{row.label}</span>
                </div>
                <div className="mt-[0.3mm] text-[8.8px] font-bold whitespace-nowrap" style={{ color: ACCENT }}>
                  {links[row.key]}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
