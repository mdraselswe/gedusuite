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

/**
 * A colour per channel, so a list can be read by where its orders came from
 * without anybody reading the words.
 *
 * Flat weights on purpose: a channel is a category, not a verdict. Nothing
 * here is good or bad news, so no one of them is allowed to shout — the states
 * that DO mean something (a cancellation, an unpaid balance) have to stay the
 * loudest thing on the row.
 *
 * Where possible the hue is the one people already associate with the place:
 * Facebook blue, WhatsApp green, Instagram pink.
 */
export const ORDER_SOURCE_TONE: Record<string, string> = {
  WEBSITE: "border-sky-500/50 text-sky-700 dark:text-sky-400",
  FACEBOOK: "border-blue-600/50 text-blue-700 dark:text-blue-400",
  WHATSAPP: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  INSTAGRAM: "border-pink-500/50 text-pink-700 dark:text-pink-400",
  PHONE: "border-teal-500/50 text-teal-700 dark:text-teal-400",
  REFERRAL: "border-violet-500/50 text-violet-700 dark:text-violet-400",
  STALL: "border-orange-500/50 text-orange-700 dark:text-orange-400",
  WALK_IN: "border-stone-500/50 text-stone-700 dark:text-stone-400",
  OTHER: "border-muted-foreground/40 text-muted-foreground",
};

/**
 * Untagged. Dashed and amber rather than muted: it is the one value in this
 * column somebody can act on, and fading it out is how a whole month of orders
 * ended up attributed to nothing.
 */
export const NO_SOURCE_TONE = "border-dashed border-amber-500/50 text-amber-700 dark:text-amber-400";

export function orderSourceTone(v?: string | null): string {
  return v ? (ORDER_SOURCE_TONE[v] ?? ORDER_SOURCE_TONE.OTHER) : NO_SOURCE_TONE;
}
