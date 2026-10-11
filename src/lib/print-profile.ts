import { z } from "zod";
import { normalizePhone } from "@/lib/phone";

/**
 * What a workspace's printed extras say about the shop.
 *
 * The gift tag and the leaflet used to carry one particular shop's name, logo,
 * social links, WhatsApp number and wording as constants in the component. Every
 * one of those is now a workspace setting, and anything left blank is simply
 * not printed — a shop with no Facebook page gets no Facebook QR rather than
 * somebody else's.
 *
 * Stored as one JSON document on Workspace.printProfile: it is read whole, it
 * is only ever shown on paper, and adding a line to a leaflet should not need a
 * migration.
 */
export const PrintProfileSchema = z
  .object({
    facebook: z.string().trim().max(160),
    whatsapp: z.string().trim().max(30),
    /** One line under the logo on the leaflet. */
    tagline: z.string().trim().max(90),
    /** The leaflet's big headline. `\n` breaks the line. */
    headline: z.string().trim().max(120),
    giftLead: z.string().trim().max(200),
    giftQuote: z.string().trim().max(120),
    giftThanks: z.string().trim().max(300),
    giftClosing: z.string().trim().max(200),
  })
  .partial();

export type PrintProfile = z.infer<typeof PrintProfileSchema>;

/** Whatever is stored, read defensively: a bad row must not break printing. */
export function parsePrintProfile(raw: unknown): PrintProfile {
  const r = PrintProfileSchema.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

export type Contact = { display: string; url: string };

/** "gedushop.com", "https://x.com/" … -> something printable and scannable. */
export function websiteContact(raw?: string | null): Contact | null {
  const v = (raw ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!v) return null;
  return { display: v, url: `https://${v}` };
}

export function facebookContact(raw?: string | null): Contact | null {
  let v = (raw ?? "").trim();
  if (!v) return null;
  v = v.replace(/^https?:\/\/(www\.|m\.)?/i, "").replace(/\/+$/, "");
  // A bare page name ("littlenest") is what people type.
  if (!/^facebook\.com\//i.test(v) && !/^fb\.com\//i.test(v)) v = `facebook.com/${v.replace(/^@/, "")}`;
  return { display: v, url: `https://${v}` };
}

/** A Bangladeshi mobile number: shown as typed, linked through wa.me with +880. */
export function whatsappContact(raw?: string | null): Contact | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const local = normalizePhone(trimmed);
  const digits = local && /^01\d{9}$/.test(local) ? `88${local}` : trimmed.replace(/\D/g, "");
  if (!digits) return null;
  return { display: trimmed, url: `https://wa.me/${digits}` };
}

export type ResolvedPrintProfile = {
  shopName: string;
  logoUrl: string | null;
  website: Contact | null;
  facebook: Contact | null;
  whatsapp: Contact | null;
  tagline: string;
  headline: string;
  giftLead: string;
  giftQuote: string;
  giftThanks: string;
  giftClosing: string;
};

/** Fill the blanks with wording that is true of any shop. */
export function resolvePrintProfile(input: {
  name: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  printProfile: unknown;
}): ResolvedPrintProfile {
  const p = parsePrintProfile(input.printProfile);
  return {
    shopName: input.name,
    logoUrl: input.logoUrl,
    website: websiteContact(input.websiteUrl),
    facebook: facebookContact(p.facebook),
    whatsapp: whatsappContact(p.whatsapp),
    tagline: p.tagline ?? "",
    headline: p.headline || input.name,
    giftLead: p.giftLead || "🎁 ছোট্ট একটি উপহার, আমাদের পক্ষ থেকে ভালোবাসার নিদর্শন।",
    giftQuote: p.giftQuote ?? "আপনার বিশ্বাসই আমাদের শক্তি।",
    giftThanks:
      p.giftThanks ||
      `${input.name} পরিবারের অংশ হওয়ার জন্য আন্তরিক ধন্যবাদ। আশা করি উপহারটি আপনার ভালো লাগবে। আবারও আপনার পরবর্তী অর্ডারে আপনাকে স্বাগত!`,
    giftClosing: p.giftClosing || "💜 আপনার হাসিমুখই আমাদের সবচেয়ে বড় পাওয়া!",
  };
}
