/**
 * Where an order came from.
 *
 * Stored on Order as a plain string, not an enum: adding a channel is then a
 * line here rather than a Postgres type migration on the busiest table in the
 * app. The trade is that the database won't reject an unknown value, so the
 * server action validates against this list before writing.
 */

export const ORDER_SOURCES = [
  "WEBSITE",
  "FACEBOOK",
  "WHATSAPP",
  "INSTAGRAM",
  "PHONE",
  "REFERRAL",
  "STALL",
  "WALK_IN",
  "OTHER",
] as const;

export type OrderSource = (typeof ORDER_SOURCES)[number];

export const ORDER_SOURCE_LABEL: Record<string, string> = {
  WEBSITE: "Website",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  PHONE: "Phone call",
  REFERRAL: "Referral",
  STALL: "Stall / mela",
  WALK_IN: "Walk-in",
  OTHER: "Other",
};

export function isOrderSource(v: unknown): v is OrderSource {
  return typeof v === "string" && (ORDER_SOURCES as readonly string[]).includes(v);
}

/** What an untagged order is called everywhere it's shown. */
export const NO_SOURCE_LABEL = "Not set";

export function orderSourceLabel(v?: string | null) {
  if (!v) return NO_SOURCE_LABEL;
  return ORDER_SOURCE_LABEL[v] ?? v;
}
