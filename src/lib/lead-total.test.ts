import { describe, expect, it } from "vitest";
import { leadBreakdown, suggestedLeadTotal } from "@/lib/lead-total";

describe("suggestedLeadTotal", () => {
  it("adds delivery to what the items came to", () => {
    expect(suggestedLeadTotal(920, 80)).toBe(1000);
  });

  it("is just the items when delivery is free", () => {
    expect(suggestedLeadTotal(920, 0)).toBe(920);
  });

  it("rounds to paisa rather than trailing a float", () => {
    expect(suggestedLeadTotal(0.1, 0.2)).toBe(0.3);
  });

  it("ignores a negative delivery charge", () => {
    expect(suggestedLeadTotal(920, -50)).toBe(920);
  });

  it("suggests nothing when the items have no prices", () => {
    // Free-typed items on a phone order: there is nothing to add up, so the
    // total stays whatever the caller agreed.
    expect(suggestedLeadTotal(null, 80)).toBeNull();
  });
});

describe("leadBreakdown", () => {
  it("shows the items and the delivery when the items are priced", () => {
    expect(leadBreakdown(920, 80, 1000)).toEqual({ goods: 920, delivery: 80 });
  });

  it("reads the split back out of the total when the items aren't priced", () => {
    expect(leadBreakdown(null, 80, 1000)).toEqual({ goods: 920, delivery: 80 });
  });

  it("rounds the derived goods figure", () => {
    expect(leadBreakdown(null, 0.2, 1)).toEqual({ goods: 0.8, delivery: 0.2 });
  });

  it("never reports negative goods", () => {
    // Mid-edit: a delivery charge typed larger than the total so far.
    expect(leadBreakdown(null, 500, 100)).toEqual({ goods: 0, delivery: 500 });
  });

  it("shows nothing when there is no delivery and no prices", () => {
    expect(leadBreakdown(null, 0, 1000)).toBeNull();
  });

  it("shows nothing on an empty form", () => {
    expect(leadBreakdown(null, 0, 0)).toBeNull();
  });

  it("still shows a priced order with free delivery", () => {
    expect(leadBreakdown(920, 0, 920)).toEqual({ goods: 920, delivery: 0 });
  });
});
