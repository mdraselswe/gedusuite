/**
 * The shop and everyone calling from it are in Bangladesh; the server runs in
 * UTC. Formatting a late-evening order with plain toISOString() shows it as
 * the day before, so anything a person reads goes through here.
 *
 * Bangladesh is UTC+6 all year — no daylight saving — so a fixed offset is
 * correct rather than merely convenient, and a naive "2026-08-04T21:30" typed
 * into a form can be pinned to a real instant without a timezone library.
 */

export const DHAKA_TZ = "Asia/Dhaka";
const DHAKA_OFFSET = "+06:00";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: DHAKA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DHAKA_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "2026-08-04" — also the sort and grouping key, so it stays date-only. */
export function formatDhakaDate(d: Date): string {
  return dateFmt.format(d);
}

/** "9:30 PM" */
export function formatDhakaTime(d: Date): string {
  return timeFmt.format(d);
}

/** "2026-08-04T21:30", the shape an <input type="datetime-local"> wants. */
export function toDhakaInputValue(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DHAKA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // en-CA renders midnight as "24" rather than "00" in some runtimes.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/**
 * A datetime-local value carries no timezone, and `new Date(...)` would read
 * it in the *server's* zone — UTC on Vercel — quietly shifting every hand-typed
 * order six hours. Pin it to Dhaka instead.
 *
 * Returns null for anything unparseable so a bad value falls back to "now"
 * rather than writing an Invalid Date.
 */
export function dhakaInputToDate(value: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((value ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${DHAKA_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
