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
  const onePercentNet = { codFeePercent: 1, codFeeBase: "NET" as const };

  it("is what was collected less what the courier keeps", () => {
    // 1500 collected, 195 of delivery bills, 1% of the 1305 left = 13.05 -> 13.
    expect(
      expectedCourierBalance(
        [
          { codAmount: 1000, deliveryCost: 115 },
          { codAmount: 500, deliveryCost: 80 },
        ],
        onePercentNet,
      ),
    ).toBe(1292);
  });

  it("matches the payout Steadfast actually made", () => {
    // SFC-31257680: 18,199 collected, 2,075 of delivery bills, and Steadfast
    // charged 161 — not the 161.24 that summing the orders' own fees gives.
    const balance = expectedCourierBalance(
      [{ codAmount: 18199, deliveryCost: 2075 }],
      onePercentNet,
    );
    expect(balance).toBe(15963);
  });

  it("rounds the fee up when it lands on a half taka", () => {
    // SFC-31364675: 18,760 collected, 2,410 of delivery bills. 1% of the
    // 16,350 left is exactly 163.50 and Steadfast charged 164 — flooring it
    // predicted 16,187 against a payout of 16,186, which is the sort of
    // one-taka gap somebody spends an evening looking for.
    expect(
      expectedCourierBalance([{ codAmount: 18760, deliveryCost: 2410 }], onePercentNet),
    ).toBe(16186);
  });

  it("matches the balance its app is showing right now", () => {
    // 11,920 collected on the parcels it still holds, 1,200 of delivery bills
    // — 1% of 10,720 is 107.20, and the app says 10,613.
    expect(
      expectedCourierBalance([{ codAmount: 11920, deliveryCost: 1200 }], onePercentNet),
    ).toBe(10613);
  });

  it("charges no fee on a set that collected less than its delivery bills", () => {
    // A month of nothing but returns. The fee base is negative, and a negative
    // fee would hand the shop money the courier never took.
    expect(
      expectedCourierBalance([{ codAmount: 0, deliveryCost: 115 }], onePercentNet),
    ).toBe(-115);
  });

  it("is zero with nothing outstanding", () => {
    expect(expectedCourierBalance([], onePercentNet)).toBe(0);
  });
});

describe("weight bands", () => {
  // Steadfast, as this shop's own parcels price it: 55 for a light Dhaka
  // parcel and 65 for a full one, 115 outside up to half a kilo and 20 per
  // started kilo after that.
  const banded: CourierRules = {
    baseWeightKg: 0.5,
    extraKgRate: 20,
    codFeePercent: 1,
    codFeeBase: "NET",
    returnChargeType: "NONE",
    returnChargeValue: 0,
  };
  const dhaka = [
    { uptoKg: 0.25, rate: 55 },
    { uptoKg: 0.5, rate: 65 },
  ];
  const outside = [{ uptoKg: 0.5, rate: 115 }];

  it("charges a light Dhaka parcel the light rate", () => {
    // CN#282716647, 0.15kg, 230 COD: Steadfast charged 55, and the flat-rate
    // model said 65 — ten taka of unexplained gap on the balance page.
    const q = quoteCourier(banded, { zoneRate: 65, bands: dhaka, weightKg: 0.15, codAmount: 230 });
    expect(q.deliveryCharge).toBe(55);
    expect(q.codFee).toBe(1.75);
  });

  it("charges a full Dhaka parcel the standard rate", () => {
    const q = quoteCourier(banded, { zoneRate: 65, bands: dhaka, weightKg: 0.41, codAmount: 920 });
    expect(q.deliveryCharge).toBe(65);
  });

  it("adds a started kilo above the heaviest band", () => {
    // CN#255141071, 0.8kg outside Dhaka: 115 for the first half kilo, 20 for
    // the rest. The old model included a whole kilo and quoted 115.
    const q = quoteCourier(banded, { zoneRate: 115, bands: outside, weightKg: 0.8, codAmount: 2500 });
    expect(q.deliveryCharge).toBe(135);
  });

  it("takes the heaviest band when nobody weighed the parcel", () => {
    // Never the cheapest: a delivery cost that is too low makes an order look
    // more profitable than it was, and nobody goes looking for that.
    const q = quoteCourier(banded, { zoneRate: 65, bands: dhaka, weightKg: null, codAmount: 920 });
    expect(q.deliveryCharge).toBe(65);
  });

  it("leaves a zone with no bands exactly as it was", () => {
    const q = quoteCourier(steadfast, { zoneRate: 115, weightKg: 0.4, codAmount: 960 });
    expect(q.deliveryCharge).toBe(115);
  });

  it("reads bands given in any order", () => {
    const q = quoteCourier(banded, {
      zoneRate: 65,
      bands: [...dhaka].reverse(),
      weightKg: 0.15,
      codAmount: 230,
    });
    expect(q.deliveryCharge).toBe(55);
  });
});
