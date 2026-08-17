import { describe, expect, it } from "vitest";
import { parcelJourney, type JourneyActivity, type JourneyOrder } from "@/lib/parcel-journey";

const at = (iso: string) => new Date(iso);

const order = (over: Partial<JourneyOrder> = {}): JourneyOrder => ({
  createdAt: at("2026-08-14T08:53:00Z"),
  status: "SHIPPED",
  deliveryType: "COURIER",
  courierTrackingId: "283640539",
  courierStatus: null,
  courierStatusAt: null,
  cashInTreasury: false,
  returnLeg: "NONE",
  returnLegAt: null,
  cancelledCollected: 0,
  ...over,
});

const log = (
  createdAt: string,
  summary: string,
  changes: unknown = null,
  action = "UPDATE",
): JourneyActivity => ({ createdAt: at(createdAt), summary, changes, action });

/** Masud Kaisar's parcel, as the audit trail actually holds it. */
const REAL: JourneyActivity[] = [
  log("2026-08-14T08:53:00Z", "Created — 2 item(s), packed", null, "CREATE"),
  log("2026-08-14T08:53:01Z", "Came from set to WEBSITE", { source: { to: "WEBSITE" } }),
  log("2026-08-14T08:53:20Z", "Booked with Steadfast — consignment 283640539, COD 1840.00"),
  log("2026-08-14T09:16:00Z", "Tagged to campaign GeduShop Sales Test"),
  log("2026-08-14T15:19:00Z", "Courier says: pending"),
  log("2026-08-14T16:20:00Z", "Status set to shipped", { status: { from: "PACKED", to: "SHIPPED" } }),
  log("2026-08-16T06:31:00Z", "Courier says: delivered"),
  log("2026-08-17T04:06:00Z", "Courier says: delivered — order marked delivered and paid"),
];

describe("parcelJourney", () => {
  it("picks five moments out of a log that holds twelve", () => {
    const steps = parcelJourney(
      order({ status: "DELIVERED", courierStatus: "delivered" }),
      REAL,
    );
    expect(steps.map((s) => [s.key, s.at?.toISOString() ?? null])).toEqual([
      ["ordered", "2026-08-14T08:53:00.000Z"],
      ["booked", "2026-08-14T08:53:20.000Z"],
      ["shipped", "2026-08-14T16:20:00.000Z"],
      ["arrived", "2026-08-16T06:31:00.000Z"],
      ["settled", null],
    ]);
    expect(steps.map((s) => s.done)).toEqual([true, true, true, true, false]);
    expect(steps[1].detail).toBe("283640539");
  });

  it("takes the status change over the sentence beside it", () => {
    // `{status: {to: "SHIPPED"}}` is a fact; "Status set to shipped" is wording
    // somebody may reword. Both are present above and the earlier one wins
    // here only because they are the same row.
    const reworded = REAL.map((a) =>
      a.summary === "Status set to shipped" ? { ...a, summary: "Marked as gone out" } : a,
    );
    const steps = parcelJourney(order(), reworded);
    expect(steps.find((s) => s.key === "shipped")?.at?.toISOString()).toBe(
      "2026-08-14T16:20:00.000Z",
    );
  });

  it("counts a parcel booked when only its consignment number says so", () => {
    // Typed in by hand from the courier's app: no log line, but a tracking id
    // can only have come from a booking. "Not booked" would be the worse lie.
    const steps = parcelJourney(order(), [REAL[0]]);
    const booked = steps.find((s) => s.key === "booked")!;
    expect(booked.done).toBe(true);
    expect(booked.at).toBeNull();
  });

  it("counts a delivered parcel as shipped even with no shipping recorded", () => {
    // The parcel cannot have arrived without going.
    const steps = parcelJourney(
      order({ status: "DELIVERED" }),
      [REAL[0], REAL[7]],
    );
    expect(steps.find((s) => s.key === "shipped")?.done).toBe(true);
    expect(steps.find((s) => s.key === "arrived")?.done).toBe(true);
  });

  it("leaves the steps ahead of the parcel empty", () => {
    const steps = parcelJourney(order({ status: "PACKED" }), REAL.slice(0, 4));
    expect(steps.filter((s) => s.done).map((s) => s.key)).toEqual(["ordered", "booked"]);
    expect(steps.find((s) => s.key === "arrived")?.at).toBeNull();
  });

  it("dates delivery from the courier saying so, not from us hearing it", () => {
    // This parcel's courier said delivered, walked it back to
    // approval-pending, and said delivered again a day later — which is when
    // the sync marked the order. The customer took it on the first date.
    const steps = parcelJourney(order({ status: "DELIVERED" }), REAL);
    expect(steps.find((s) => s.key === "arrived")?.at?.toISOString()).toBe(
      "2026-08-16T06:31:00.000Z",
    );
  });

  it("does not read approval-pending as delivered", () => {
    // "Courier says: delivered_approval_pending" starts with the same words as
    // "Courier says: delivered" and means the opposite.
    const steps = parcelJourney(order(), [
      REAL[0],
      log("2026-08-15T00:00:00Z", "Courier says: delivered_approval_pending"),
    ]);
    expect(steps.find((s) => s.key === "arrived")?.at).toBeNull();
    expect(steps.find((s) => s.key === "arrived")?.done).toBe(false);
  });

  it("repeats what the courier last said while it is still saying it", () => {
    const steps = parcelJourney(
      order({ courierStatus: "delivered_approval_pending" }),
      REAL.slice(0, 6),
    );
    expect(steps.find((s) => s.key === "shipped")?.detail).toBe("delivered approval pending");
  });

  it("stays quiet about a courier status that says nothing yet", () => {
    const steps = parcelJourney(order({ courierStatus: "in_review" }), REAL.slice(0, 6));
    expect(steps.find((s) => s.key === "shipped")?.detail).toBeUndefined();
  });

  it("stops repeating the courier once the parcel has arrived", () => {
    // The step below names the ending in words somebody chose; echoing
    // "partial delivered" above it says the same thing twice, worse.
    const steps = parcelJourney(
      order({ status: "CANCELLED", courierStatus: "partial_delivered", cancelledCollected: 120 }),
      REAL.slice(0, 6),
    );
    expect(steps.find((s) => s.key === "shipped")?.detail).toBeUndefined();
    expect(steps.find((s) => s.key === "arrived")?.label).toBe("Partly delivered");
  });

  it("names the three ways a cancellation ends", () => {
    const returned = parcelJourney(
      order({ status: "CANCELLED", returnLeg: "RECEIVED" }),
      REAL,
    );
    expect(returned.find((s) => s.key === "arrived")?.label).toBe("Returned");

    const partial = parcelJourney(
      order({ status: "CANCELLED", cancelledCollected: 130 }),
      REAL,
    );
    expect(partial.find((s) => s.key === "arrived")?.label).toBe("Partly delivered");

    const plain = parcelJourney(order({ status: "CANCELLED" }), REAL);
    expect(plain.find((s) => s.key === "arrived")?.label).toBe("Cancelled");
  });

  it("ends on the money, and says which way it went", () => {
    const banked = log("2026-08-17T05:00:00Z", "Cash marked as reaching the treasury — ৳846.45", {
      cashInTreasury: { from: false, to: true },
    });
    const inward = parcelJourney(order({ cashInTreasury: true }), [...REAL, banked]);
    expect(inward.at(-1)).toMatchObject({
      key: "settled",
      label: "Money in the treasury",
      done: true,
    });

    // A parcel that came back collected nothing and still cost the trip, so
    // the last step is money leaving rather than arriving.
    const charged = log("2026-08-17T05:00:00Z", "Courier charges settled — ৳105 out of the treasury", {
      cashInTreasury: { from: false, to: true },
    });
    const outward = parcelJourney(
      order({ status: "CANCELLED", cashInTreasury: true }),
      [...REAL, charged],
    );
    expect(outward.at(-1)?.label).toBe("Courier charges paid");
  });

  it("has no booking step for an order nobody couriered", () => {
    const steps = parcelJourney(
      order({ deliveryType: "SELF", courierTrackingId: null, status: "DELIVERED" }),
      [REAL[0]],
    );
    expect(steps.map((s) => s.key)).toEqual(["ordered", "shipped", "arrived", "settled"]);
    expect(steps[1].label).toBe("Out for delivery");
  });

  it("falls back to the order's own timestamp on a row older than the log", () => {
    const steps = parcelJourney(order(), []);
    expect(steps[0].at?.toISOString()).toBe("2026-08-14T08:53:00.000Z");
  });
});
