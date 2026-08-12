import { cn } from "@/lib/utils";

/**
 * A record's date on screen, with the time of day next to it.
 *
 * Every list here used to print a bare "2026-08-12", which answers "which day"
 * and nothing else — two orders an hour apart looked simultaneous, and the order
 * they were taken in was only recoverable from the activity log. The time rides
 * along muted: the day is what a reader scans a column for, the time is what
 * they look at once they have found the row.
 *
 * Where the two halves come from different days — a purchase dated yesterday,
 * typed up after midnight — the time says "entered" so it can't be read as a
 * moment on the date beside it, and the tooltip gives the whole stamp. Both
 * halves are built by lib/dhaka-time (dhakaStamp / dhakaInstant).
 */
export function Stamp({
  date,
  time,
  entered,
  timeOnly = false,
  className,
}: {
  /** "2026-08-12" — the day the record belongs to. */
  date: string;
  /** "3:42 PM", or null where there is no timestamp to show. */
  time?: string | null;
  /** Set when `time` is an entry time from another day; also the tooltip text. */
  entered?: string | null;
  /** Just the time half — for a table whose heading already carries the day. */
  timeOnly?: boolean;
  className?: string;
}) {
  const label = time && (entered ? `entered ${time}` : time);
  return (
    <span
      className={cn("whitespace-nowrap", timeOnly && "text-muted-foreground", className)}
      title={entered ?? undefined}
      // A dotted underline is the only hint that there is more to hover, and
      // only where there actually is.
      style={entered ? { textDecoration: "underline dotted", textUnderlineOffset: 3 } : undefined}
    >
      {timeOnly ? (
        (label ?? "—")
      ) : (
        <>
          {date}
          {label && <span className="ml-1 text-xs text-muted-foreground">· {label}</span>}
        </>
      )}
    </span>
  );
}
