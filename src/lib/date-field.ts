import { z } from "zod";
import { dhakaInputToDate } from "@/lib/dhaka-time";

/**
 * When something happened, as a form said it: the instant, and whether a time of
 * day was actually given.
 *
 * Both halves are stored — see the `dateHasTime` column. A record whose date came
 * from a plain date picker has no time in it, and reading one off the timestamp
 * afterwards is impossible: 6 AM in Dhaka is midnight UTC, so a sale timed at
 * 6 AM and a row that never had a time look identical. The flag says which.
 */
export type SubmittedDate = { at: Date; hasTime: boolean };

/**
 * The date a record happened on, as it arrives from a form.
 *
 * The forms send "2026-08-12T15:42" — a datetime-local value, which carries no
 * timezone at all. `z.coerce.date()` hands that to `new Date()`, which reads it
 * in the SERVER's zone: UTC on Vercel. Every order typed in Dhaka would land six
 * hours early, so an evening sale would be filed on the previous day and the
 * reports would disagree with the shop. Pinning it to Dhaka is the whole point of
 * this field existing (see lib/dhaka-time).
 *
 * A plain "2026-08-12" is still accepted, means midnight UTC, and reports
 * `hasTime: false`. That is not a leftover: the offline queue replays payloads
 * captured before this change, and the mutations API takes whatever a queued
 * request held.
 */
export const dhakaDateField: z.ZodType<SubmittedDate, unknown> = z
  .preprocess((v) => {
    if (typeof v !== "string") return v;
    const s = v.trim();
    const pinned = dhakaInputToDate(s);
    // A datetime-local value only carries a time when it actually has one; the
    // same parser accepts "2026-08-12T00:00", and midnight typed on purpose is a
    // time somebody chose.
    if (pinned) return { at: pinned, hasTime: /T\d{2}:\d{2}/.test(s) };
    // Date-only, from an older client or a queued payload.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return { at: new Date(`${s}T00:00:00.000Z`), hasTime: false };
    }
    // Anything else — an ISO instant with a real offset, say — is already
    // unambiguous and is a moment rather than a day.
    return { at: v, hasTime: true };
  }, z.object({ at: z.coerce.date(), hasTime: z.boolean() }))
  // The object above is an implementation detail of the preprocessing; what a
  // caller gets is the pair, with `at` guaranteed to be a real Date.
  .transform((d) => d as SubmittedDate);
