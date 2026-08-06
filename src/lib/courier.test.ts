import { describe, expect, it } from "vitest";
import {
  breakEvenDeliveryCharge,
  expectedCourierBalance,
  quoteCourier,
  quoteReturnCharge,
  type CourierRules,
} from "@/lib/courier";

const steadfast: CourierRules = {
  baseWeightKg: 1,
  extraKgRate: 20,
  codFeePercent: 1,
  codFeeBase: "GROSS",
  returnChargeType: "FLAT",
  returnChargeValue: 50,
};

describe("quoteCourier", () => {
  it("reproduces the case the whole module was written for", () => {
    // 115 to send it, plus 1% of a 960 COD, is 123.45 — not 115. Charging the
    // customer 120 looks like 5 of margin and is a 3.45 loss.
    const q = quoteCourier(steadfast, { zoneRate: 115, weightKg: null, codAmount: 960 });
    expect(q.deliveryCharge).toBe(115);
    expect(q.codFee).toBe(9.6);
    expect(q.total).toBe(124.6);
  });

  it("charges per STARTED kilo over the allowance", () => {
    // 1.2kg on a 1kg allowance is one extra kilo, not 0.2 of one.
    expect(quoteCourier(steadfast, { zoneRate: 100, weightKg: 1.2, codAmount: 0 }).weightCharge).toBe(20);
    expect(quoteCourier(steadfast, { zoneRate: 100, weightKg: 2.0, codAmount: 0 }).weightCharge).toBe(20);
    expect(quoteCourier(steadfast, { zoneRate: 100, weightKg: 2.1, codAmount: 0 }).weightCharge).toBe(40);
  });

  it("treats an unknown weight as within the allowance", () => {
    expect(quoteCourier(steadfast, { zoneRate: 100, weightKg: null, codAmount: 0 }).weightCharge).toBe(0);
  });

  it("takes a NET fee after the courier's own delivery charge", () => {
    const net: CourierRules = { ...steadfast, codFeeBase: "NET" };
    // 1% of (960 - 115) = 8.45, against 9.60 on GROSS.
    expect(quoteCourier(net, { zoneRate: 115, weightKg: null, codAmount: 960 }).codFee).toBe(8.45);
  });

  it("never charges a negative NET fee when the COD is under the delivery charge", () => {
    const net: CourierRules = { ...steadfast, codFeeBase: "NET" };
    expect(quoteCourier(net, { zoneRate: 115, weightKg: null, codAmount: 50 }).codFee).toBe(0);
  });

  it("charges no fee on a prepaid parcel — there is nothing to collect", () => {
    expect(quoteCourier(steadfast, { zoneRate: 115, weightKg: null, codAmount: 0 }).codFee).toBe(0);
  });
});

describe("quoteReturnCharge", () => {
  it("is flat when the courier charges flat", () => {
    expect(quoteReturnCharge(steadfast, { zoneRate: 115 })).toBe(50);
  });

  it("is a percentage of the delivery charge including weight when set that way", () => {
    const pct: CourierRules = {
      ...steadfast,
      returnChargeType: "PERCENT_OF_DELIVERY",
      returnChargeValue: 50,
    };
    expect(quoteReturnCharge(pct, { zoneRate: 100, weightKg: 2.5 })).toBe(70); // 50% of (100 + 40)
  });

  it("is nothing when the courier doesn't charge for returns", () => {
    expect(quoteReturnCharge({ ...steadfast, returnChargeType: "NONE" }, { zoneRate: 115 })).toBe(0);
  });
});

describe("breakEvenDeliveryCharge", () => {
  it("solves the charge that exactly covers itself, fee and all", () => {
    const charge = breakEvenDeliveryCharge(steadfast, { zoneRate: 115, goodsAmount: 845 });
    // Verify by re-quoting: at this charge the courier keeps exactly what the
    // customer paid for delivery.
    const q = quoteCourier(steadfast, { zoneRate: 115, weightKg: null, codAmount: 845 + charge! });
    expect(q.total).toBeCloseTo(charge!, 1);
  });

  it("solves it for a NET fee too", () => {
    const net: CourierRules = { ...steadfast, codFeeBase: "NET" };
    const charge = breakEvenDeliveryCharge(net, { zoneRate: 115, goodsAmount: 845 });
    const q = quoteCourier(net, { zoneRate: 115, weightKg: null, codAmount: 845 + charge! });
    expect(q.total).toBeCloseTo(charge!, 1);
  });

  it("gives up when the percentage can never be covered", () => {
    const greedy: CourierRules = { ...steadfast, codFeePercent: 100 };
    expect(breakEvenDeliveryCharge(greedy, { zoneRate: 115, goodsAmount: 845 })).toBeNull();
  });
});

describe("expectedCourierBalance", () => {
  it("is what was collected less what the courier keeps", () => {
    expect(
      expectedCourierBalance([
        { codAmount: 1000, deliveryCost: 115, codFee: 10 },
        { codAmount: 500, deliveryCost: 80, codFee: 5 },
      ]),
    ).toBe(1290);
  });

  it("is zero with nothing outstanding", () => {
    expect(expectedCourierBalance([])).toBe(0);
  });
});
