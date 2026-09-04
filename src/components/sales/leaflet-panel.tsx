import { Baloo_Da_2 } from "next/font/google";

/**
 * One panel of the GeduShop promo leaflet — four to an A4 portrait sheet
 * (see leaflet/page.tsx). Ported from the shop's existing leaflet design
 * (gedushop-leaflet-a4-4up.pdf) rather than redrawn: every size below is
 * that design's original pixel value halved, since the source was built at
 * ~2x the CSS-px-per-mm density this app's print sheets render at — same
 * panel, same proportions, just re-based onto this app's mm-sized sheet.
 *
 * Loaded locally rather than in the root layout: this display face is only
 * used on this one print page, so it shouldn't cost every other page in the
 * app a font fetch.
 */
const balooDa2 = Baloo_Da_2({ subsets: ["bengali", "latin"], weight: ["700", "800"], display: "swap" });

const INK = "#4f4274";
const INK_SOFT = "#6b5ca8";
const ACCENT = "#e96d65";
const ACCENT_ICON = "#d7534b";
const ACCENT_DARK = "#b23f38";
const BADGE_BORDER = "#f5aba5";
const RULE = "#e7e3f4";

export type LeafletQr = {
  /** data: URL PNGs — see leaflet/page.tsx. */
  site: string;
  facebook: string;
  whatsapp: string;
};

const CONTACT_ROWS: { key: keyof LeafletQr; icon: React.ReactNode; label: string; link: string }[] = [
  {
    key: "site",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="size-[14px] shrink-0">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z" />
      </svg>
    ),
    label: "ওয়েবসাইটে অর্ডার",
    link: "gedushop.com",
  },
  {
    key: "facebook",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="size-[14px] shrink-0">
        <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
      </svg>
    ),
    label: "ফেসবুক পেজে ইনবক্স",
    link: "facebook.com/gedushop",
  },
  {
    key: "whatsapp",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="size-[14px] shrink-0">
        <path d="M21 15.6v2.8a2 2 0 0 1-2.2 2A18.6 18.6 0 0 1 2.6 5.2 2 2 0 0 1 4.6 3h2.8a2 2 0 0 1 2 1.7c.1.9.3 1.7.6 2.5a2 2 0 0 1-.5 2.1L8.4 10.4a15 15 0 0 0 5.2 5.2l1.1-1.1a2 2 0 0 1 2.1-.5c.8.3 1.6.5 2.5.6a2 2 0 0 1 1.7 2z" />
      </svg>
    ),
    label: "হোয়াটসঅ্যাপ বা কল",
    link: "01552-958606",
  },
];

export function LeafletPanel({ qr }: { qr: LeafletQr }) {
  return (
    <div
      className={`${balooDa2.className} flex h-full flex-col justify-center overflow-hidden p-[20px]`}
      style={{ color: INK, fontFamily: "'Hind Siliguri', 'Noto Sans Bengali', sans-serif" }}
    >
      <div className="flex flex-col items-center gap-[4px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/branding/gedushop-logo.png" alt="GeduShop" className="block h-auto w-[90px]" />
        <div className="text-[15px] font-semibold tracking-[0.25px]" style={{ color: INK_SOFT }}>
          শিশুর জন্য যা কিছু দরকার
        </div>
      </div>

      <div className="flex flex-col items-center gap-[6px] pt-[9px] text-center">
        <h1 className="m-0 text-[22px] leading-[1.3] font-extrabold" style={{ fontFamily: "inherit", color: INK }}>
          বাচ্চাদের খেলনা ও
          <br />
          বেবি কেয়ারের সবকিছু
        </h1>
        <div className="h-[3.5px] w-[50px] rounded-[2px]" style={{ background: ACCENT }} />
      </div>

      <div className="flex flex-wrap justify-center gap-[6px] pt-[9px]">
        <span className="flex items-center gap-[4.5px] rounded-full px-[8px] py-[4px]" style={{ border: `1px solid ${BADGE_BORDER}` }}>
          <svg viewBox="0 0 24 24" fill="none" stroke={ACCENT_ICON} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="size-[15px] shrink-0">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <circle cx="12" cy="12" r="2.6" />
            <path d="M6 12h.01" />
            <path d="M18 12h.01" />
          </svg>
          <span className="text-[15px] font-semibold" style={{ color: ACCENT_DARK }}>
            ক্যাশ অন ডেলিভারি
          </span>
        </span>
        <span className="flex items-center gap-[4.5px] rounded-full px-[8px] py-[4px]" style={{ border: `1px solid ${BADGE_BORDER}` }}>
          <svg viewBox="0 0 24 24" fill="none" stroke={ACCENT_ICON} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="size-[15px] shrink-0">
            <rect x="1.5" y="6" width="12.5" height="10" rx="1.5" />
            <path d="M14 9.5h4L21.5 13v3H14z" />
            <circle cx="6" cy="18" r="2.2" />
            <circle cx="17.5" cy="18" r="2.2" />
          </svg>
          <span className="text-[15px] font-semibold" style={{ color: ACCENT_DARK }}>
            সারা দেশে ডেলিভারি
          </span>
        </span>
      </div>

      <div className="pt-[7px] text-center text-[17px] leading-[1.3] font-bold" style={{ fontFamily: "inherit", color: ACCENT_DARK }}>
        ডেলিভারি ফ্রি! ডেলিভারি ফ্রি! ডেলিভারি ফ্রি!
      </div>

      <div className="flex items-center gap-[8px] pt-[12px]">
        <div className="h-[1px] flex-grow" style={{ background: RULE }} />
        <div className="text-[17px] font-bold" style={{ fontFamily: "inherit", color: INK_SOFT }}>
          অর্ডার করবেন যেভাবে
        </div>
        <div className="h-[1px] flex-grow" style={{ background: RULE }} />
      </div>

      <div className="pt-[6px] text-center text-[15px] leading-[1.4] text-balance" style={{ color: INK_SOFT }}>
        পণ্য বাছুন → নাম, ফোন ও ঠিকানা দিন → হাতে পেয়ে টাকা দিন
      </div>

      <div className="flex flex-col items-center gap-[7px] self-center pt-[9px]">
        {CONTACT_ROWS.map((row) => (
          <div key={row.key} className="flex items-center gap-[8px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr[row.key]} alt="" className="size-[56px] shrink-0" />
            <span className="flex min-w-0 flex-col gap-[1px]">
              <span className="flex items-center gap-[4.5px]">
                {row.icon}
                <span className="text-[16px] font-bold" style={{ fontFamily: "inherit", color: INK }}>
                  {row.label}
                </span>
              </span>
              <span className="text-[16px] font-semibold" style={{ color: ACCENT_DARK }}>
                {row.link}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
