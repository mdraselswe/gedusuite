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

/**
 * How a record's date reads in a list: the day it belongs to, plus the time of
 * day.
 *
 * There are two kinds of date here. Most are a real moment — the forms ask for a
 * date AND a time, so what is stored is when the sale was made or the money
 * moved. The rest are date-only, either a row entered before the forms asked for
 * a time or a value that never had one; those are exactly midnight UTC, and the
 * time worth showing for them is when the row was entered, which is `createdAt`.
 * dhakaRecordStamp picks between the two.
 *
 * An entry time belonging to a different day than the record is dated is still
 * shown — a purchase dated the 11th and typed up at 4:20 AM on the 12th was
 * entered four hours later, and most older rows here are like that — but it is
 * labelled as an entry time rather than presented as a moment on the record's
 * own date. `entered` carries the full stamp for the tooltip, and doubles as the
 * flag that this is what happened.
 */
export type DhakaStamp = {
  /** "2026-08-12" — the day the record belongs to, and the sort/group key. */
  date: string;
  /** "3:42 PM" — null only where there is no timestamp at all to read. */
  time: string | null;
  /**
   * Full stamp for the tooltip, set only when the record was entered on some
   * other day than it is dated. Non-null means `time` is an entry time on a
   * different day, and has to be shown as one.
   */
  entered: string | null;
  /**
   * "2026-08-12T15:42" — the record's own stored instant, in the shape an edit
   * form's datetime-local input wants. Never the entry time: a form must open on
   * what is stored, so saving it back unchanged changes nothing.
   */
  dateInput: string;
};

export function dhakaStamp(date: Date, createdAt: Date): DhakaStamp {
  const day = dateFmt.format(date);
  const enteredDay = dateFmt.format(createdAt);
  const time = timeFmt.format(createdAt);
  return {
    date: day,
    time,
    entered: enteredDay === day ? null : `Entered ${enteredDay} at ${time}`,
    dateInput: toDhakaInputValue(date),
  };
}

/**
 * The same shape for a value that is itself a moment rather than a picked day —
 * a website order's placed-at, a backup run, a courier status change. The time
 * comes from the value, because it has one.
 */
export function dhakaInstant(d: Date): DhakaStamp {
  return {
    date: dateFmt.format(d),
    time: timeFmt.format(d),
    entered: null,
    dateInput: toDhakaInputValue(d),
  };
}

/**
 * A record's stamp, reading its own time when it has one and falling back to
 * when it was entered when it doesn't.
 *
 * `hasTime` is the record's own `dateHasTime` column, not a guess from the
 * timestamp: 6:00 AM in Dhaka is midnight UTC, so a sale deliberately timed at
 * 6 AM and a row that never had a time are the same instant. Only the column can
 * tell them apart, which is why it exists.
 */
export function dhakaRecordStamp(date: Date, createdAt: Date, hasTime: boolean): DhakaStamp {
  return hasTime ? dhakaInstant(date) : dhakaStamp(date, createdAt);
}

/**
 * "2026-08-12 · 3:42 PM" as one string, for a label in a sentence rather than a
 * cell in a table — "Last backup: …", where there is nothing to line up with.
 */
export function dhakaStampLine(d: Date): string {
  return `${dateFmt.format(d)} · ${timeFmt.format(d)}`;
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

// ── Reporting boundaries ────────────────────────────────────────────
//
// A day in this business runs midnight to midnight in Dhaka, not in UTC. The
// difference is six hours, which is enough to put a late-evening order on the
// wrong day, and an order placed just after midnight on the first of a month
// into the month before. Every date a report groups by or filters on goes
// through here.

/** Start of that Dhaka calendar day, as a real instant. "2026-08-04" → 03 Aug 18:00Z. */
export function dhakaDayStart(day: string): Date {
  return new Date(`${day}T00:00:00${DHAKA_OFFSET}`);
}

/** End of that Dhaka calendar day, inclusive. */
export function dhakaDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999${DHAKA_OFFSET}`);
}

/** Which Dhaka day an instant falls on — the key a report groups by. */
export function dhakaDayKey(d: Date): string {
  return dateFmt.format(d);
}

/** Today's date in Dhaka, as "YYYY-MM-DD". */
export function dhakaToday(): string {
  return dateFmt.format(new Date());
}

/** `days` before today in Dhaka, as "YYYY-MM-DD". Used for default ranges. */
export function dhakaDaysAgo(days: number): string {
  return dateFmt.format(new Date(Date.now() - days * 86_400_000));
}

/** First day of the current Dhaka month, as "YYYY-MM-DD". */
export function dhakaMonthStart(): string {
  return `${dhakaToday().slice(0, 7)}-01`;
}
