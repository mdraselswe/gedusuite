import { describe, expect, it } from "vitest";
import { dhakaInstant, dhakaStamp } from "@/lib/dhaka-time";

// Dhaka is UTC+6: 18:00Z is 12 Aug midnight in Dhaka, 15:42Z is 9:42 PM.
describe("dhakaStamp", () => {
  it("shows the time the record was entered", () => {
    expect(
      dhakaStamp(new Date("2026-08-12T00:00:00Z"), new Date("2026-08-12T09:42:00Z")),
    ).toEqual({
      date: "2026-08-12",
      time: "3:42 PM",
      entered: null,
      dateInput: "2026-08-12T06:00",
    });
  });

  it("reads the day in Dhaka, not UTC", () => {
    // 21:30 Dhaka on the 12th is 15:30Z — the same instant a bare toISOString()
    // would print as the 12th too, so use the hour that actually differs: half
    // past midnight in Dhaka is still the 11th in UTC.
    expect(dhakaStamp(new Date("2026-08-11T18:30:00Z"), new Date("2026-08-11T18:30:00Z"))).toEqual({
      date: "2026-08-12",
      time: "12:30 AM",
      entered: null,
      dateInput: "2026-08-12T00:30",
    });
  });

  it("flags a time that belongs to another day, rather than dropping it", () => {
    // Dated the 9th, typed up on the 12th. The time is still worth showing —
    // most rows here are entered after the day they are dated — but `entered`
    // says so, and the UI labels it instead of passing it off as a moment on
    // the 9th.
    expect(
      dhakaStamp(new Date("2026-08-09T00:00:00Z"), new Date("2026-08-12T09:42:00Z")),
    ).toEqual({
      date: "2026-08-09",
      time: "3:42 PM",
      entered: "Entered 2026-08-12 at 3:42 PM",
      dateInput: "2026-08-09T06:00",
    });
  });

  it("treats entry just after midnight as the other day it is", () => {
    // The common case in this shop: a purchase dated the 11th, entered at
    // 4:20 AM on the 12th — four hours later, but a different day.
    const s = dhakaStamp(new Date("2026-08-11T00:00:00Z"), new Date("2026-08-11T22:20:00Z"));
    expect(s.date).toBe("2026-08-11");
    expect(s.time).toBe("4:20 AM");
    expect(s.entered).toBe("Entered 2026-08-12 at 4:20 AM");
  });

  it("compares the two days in Dhaka as well", () => {
    // Entered at 12:30 AM Dhaka on the 12th — the same Dhaka day as a record
    // dated the 12th, even though UTC still says the 11th.
    expect(dhakaStamp(new Date("2026-08-12T00:00:00Z"), new Date("2026-08-11T18:30:00Z"))).toEqual({
      date: "2026-08-12",
      time: "12:30 AM",
      entered: null,
      dateInput: "2026-08-12T06:00",
    });
  });
});

describe("dhakaInstant", () => {
  it("takes the time from the value itself", () => {
    expect(dhakaInstant(new Date("2026-08-11T18:30:00Z"))).toEqual({
      date: "2026-08-12",
      time: "12:30 AM",
      entered: null,
      dateInput: "2026-08-12T00:30",
    });
  });
});
