import { describe, expect, it } from "vitest";
import {
  addMonths,
  amortizeAll,
  prepaidRemaining,
  recognizedInPeriod,
  spreadWindow,
} from "@/lib/amortize";

const d = (iso: string) => new Date(iso);

/** The real one: a year of hosting bought on 25 April. */
const hosting = { date: d("2026-04-25T00:00:00Z"), amount: 4861, spreadMonths: 12 };
/** A month of AI subscription bought on 5 August. */
const ai = { date: d("2026-08-05T00:00:00Z"), amount: 2553.99, spreadMonths: 1 };
/** A bus fare — belongs where it was paid. */
const fare = { date: d("2026-06-18T00:00:00Z"), amount: 380, spreadMonths: null };

describe("addMonths", () => {
  it("clamps to the end of a shorter month", () => {
    // Would roll forward to 3 March if left to setUTCMonth.
    expect(addMonths(d("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(d("2028-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2028-02-29");
  });

  it("keeps the day of month where it exists", () => {
    expect(addMonths(d("2026-04-25T00:00:00Z"), 12).toISOString().slice(0, 10)).toBe("2027-04-25");
    expect(addMonths(d("2026-08-05T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-09-05");
  });
});

describe("spreadWindow", () => {
  it("is null for anything not spread", () => {
    expect(spreadWindow(fare)).toBeNull();
    expect(spreadWindow({ ...fare, spreadMonths: 0 })).toBeNull();
    expect(spreadWindow({ ...fare, spreadMonths: -3 })).toBeNull();
  });

  it("runs from the purchase date to that many months later", () => {
    const w = spreadWindow(hosting)!;
    expect(w.start.toISOString().slice(0, 10)).toBe("2026-04-25");
    expect(w.end.toISOString().slice(0, 10)).toBe("2027-04-25");
  });
});

describe("recognizedInPeriod — unspread costs behave exactly as before", () => {
  it("lands entirely on its own date", () => {
    expect(recognizedInPeriod(fare, null, d("2026-08-07T00:00:00Z"))).toBe(380);
  });

  it("is in the range or out of it, never part of it", () => {
    const inside = { from: d("2026-06-01T00:00:00Z"), to: d("2026-06-30T23:59:59Z") };
    const outside = { from: d("2026-07-01T00:00:00Z"), to: d("2026-07-31T23:59:59Z") };
    expect(recognizedInPeriod(fare, inside)).toBe(380);
    expect(recognizedInPeriod(fare, outside)).toBe(0);
  });
});

describe("recognizedInPeriod — spread costs", () => {
  const now = d("2026-08-07T00:00:00Z"); // 104 days into the hosting year

  it("recognises only what has elapsed, all-time", () => {
    // 4861 x 104/365
    expect(recognizedInPeriod(hosting, null, now)).toBeCloseTo(1385.1, 0);
  });

  it("gives a whole month its own slice", () => {
    const june = { from: d("2026-06-01T00:00:00Z"), to: d("2026-07-01T00:00:00Z") };
    expect(recognizedInPeriod(hosting, june, now)).toBeCloseTo((4861 * 30) / 365, 1);
  });

  it("prorates a range that straddles the start", () => {
    // April 2026: the window opens on the 25th, so April carries the 25th to
    // the 30th inclusive — six days, not the whole month and not five.
    const april = { from: d("2026-04-01T00:00:00Z"), to: d("2026-05-01T00:00:00Z") };
    expect(recognizedInPeriod(hosting, april, now)).toBeCloseTo((4861 * 6) / 365, 1);
  });

  it("handles a range with no month boundary at all", () => {
    const odd = { from: d("2026-05-10T00:00:00Z"), to: d("2026-06-21T00:00:00Z") };
    expect(recognizedInPeriod(hosting, odd, now)).toBeCloseTo((4861 * 42) / 365, 1);
  });

  it("gives nothing to a period before it was bought", () => {
    const march = { from: d("2026-03-01T00:00:00Z"), to: d("2026-04-01T00:00:00Z") };
    expect(recognizedInPeriod(hosting, march, now)).toBe(0);
  });

  it("never reaches past today, however far the range asks", () => {
    // A range running to the end of the window must still stop at `now`.
    const wide = { from: d("2026-01-01T00:00:00Z"), to: d("2027-12-31T00:00:00Z") };
    expect(recognizedInPeriod(hosting, wide, now)).toBeCloseTo(
      recognizedInPeriod(hosting, null, now),
      2,
    );
  });

  it("recognises the whole cost once the window has passed", () => {
    const after = d("2027-06-01T00:00:00Z");
    expect(recognizedInPeriod(hosting, null, after)).toBeCloseTo(4861, 0);
    expect(prepaidRemaining(hosting, after)).toBe(0);
  });

  it("spreads a one-month subscription across the days it covers", () => {
    const twoDaysIn = d("2026-08-07T00:00:00Z");
    // 2 of ~31 days used, so most of it is still prepaid.
    expect(recognizedInPeriod(ai, null, twoDaysIn)).toBeCloseTo((2553.99 * 2) / 31, 0);
    expect(prepaidRemaining(ai, twoDaysIn)).toBeCloseTo(2553.99 - (2553.99 * 2) / 31, 0);
  });
});

describe("prepaidRemaining", () => {
  it("is nothing for an unspread cost — it was charged in full", () => {
    expect(prepaidRemaining(fare, d("2026-08-07T00:00:00Z"))).toBe(0);
  });

  it("is the whole amount the moment it's bought", () => {
    expect(prepaidRemaining(hosting, d("2026-04-25T00:00:00Z"))).toBeCloseTo(4861, 0);
  });
});

describe("amortizeAll", () => {
  it("adds up recognised and prepaid across a mixed set", () => {
    const now = d("2026-08-07T00:00:00Z");
    const { recognized, prepaid } = amortizeAll([hosting, ai, fare], null, now);
    // Everything either has been recognised or is still prepaid — nothing is
    // invented and nothing goes missing.
    expect(recognized + prepaid).toBeCloseTo(4861 + 2553.99 + 380, 0);
    expect(recognized).toBeCloseTo(1385 + 165 + 380, -1);
  });

  it("copes with an empty list", () => {
    expect(amortizeAll([], null)).toEqual({ recognized: 0, prepaid: 0 });
  });
});
