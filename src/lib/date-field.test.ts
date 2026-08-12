import { describe, expect, it } from "vitest";
import { dhakaDateField } from "@/lib/date-field";
import { dhakaRecordStamp, toDhakaInputValue } from "@/lib/dhaka-time";

const parse = (v: unknown) => dhakaDateField.parse(v);

describe("dhakaDateField", () => {
  it("reads a datetime-local value as Dhaka time, not the server's", () => {
    // 3:42 PM in Dhaka is 09:42Z. Parsed with new Date() on a UTC server this
    // would have been 3:42 PM UTC — 9:42 PM Dhaka, six hours out.
    expect(parse("2026-08-12T15:42")).toEqual({
      at: new Date("2026-08-12T09:42:00.000Z"),
      hasTime: true,
    });
  });

  it("keeps a late-evening entry on its own Dhaka day", () => {
    // The case that made this necessary: 9:30 PM on the 12th in Dhaka. Read as
    // UTC it would be 3:30 AM on the 13th Dhaka-side — the wrong day in every
    // report that groups by one.
    const { at } = parse("2026-08-12T21:30");
    expect(at.toISOString()).toBe("2026-08-12T15:30:00.000Z");
    expect(dhakaRecordStamp(at, new Date(), true).date).toBe("2026-08-12");
  });

  it("marks a plain date as having no time, at midnight UTC", () => {
    // The offline queue replays payloads captured before the forms asked for a
    // time, and this is how a record with no time of its own is stored.
    expect(parse("2026-08-12")).toEqual({
      at: new Date("2026-08-12T00:00:00.000Z"),
      hasTime: false,
    });
  });

  it("counts a deliberate midnight as a time somebody chose", () => {
    expect(parse("2026-08-12T00:00")).toEqual({
      at: new Date("2026-08-11T18:00:00.000Z"),
      hasTime: true,
    });
  });

  it("round-trips a form value through the edit form unchanged", () => {
    // Open an order, save it without touching the date: the instant must not
    // drift. The input value comes from the stamp's dateInput, and parsing it
    // again has to land on the same instant.
    const { at } = parse("2026-08-12T15:42");
    const backIntoTheForm = toDhakaInputValue(at);
    expect(backIntoTheForm).toBe("2026-08-12T15:42");
    expect(parse(backIntoTheForm).at.getTime()).toBe(at.getTime());
  });

  it("passes an ISO instant through as a real moment", () => {
    expect(parse("2026-08-12T09:42:00.000Z")).toEqual({
      at: new Date("2026-08-12T09:42:00.000Z"),
      hasTime: true,
    });
  });

  it("rejects what isn't a date at all", () => {
    expect(dhakaDateField.safeParse("not a date").success).toBe(false);
    expect(dhakaDateField.safeParse("").success).toBe(false);
  });
});

describe("what the column buys, on the one ambiguous instant", () => {
  // 6:00 AM in Dhaka IS midnight UTC. Before the dateHasTime column there was
  // nothing in the data to tell a sale timed at 6 AM from a row that never had
  // a time — the flag is the only thing that can, which is why it is stored.
  const sixAm = parse("2026-08-12T06:00");
  const dateOnly = parse("2026-08-12");
  const enteredLater = new Date("2026-08-12T11:00:00Z"); // 5 PM Dhaka

  it("stores the same instant either way", () => {
    expect(sixAm.at.getTime()).toBe(dateOnly.at.getTime());
  });

  it("shows 6 AM for the sale that was timed at 6 AM", () => {
    expect(dhakaRecordStamp(sixAm.at, enteredLater, sixAm.hasTime).time).toBe("6:00 AM");
  });

  it("shows the entry time for the row that never had one", () => {
    expect(dhakaRecordStamp(dateOnly.at, enteredLater, dateOnly.hasTime).time).toBe("5:00 PM");
  });
});
