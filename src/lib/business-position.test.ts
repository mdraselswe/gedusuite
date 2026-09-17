import { describe, expect, it } from "vitest";
import { businessMoneyPosition } from "@/lib/business-position";

describe("businessMoneyPosition", () => {
  it("splits collected money and counts net due exactly once", () => {
    expect(
      businessMoneyPosition({
        treasury: 1_000,
        dueGross: 700,
        dueNet: 620,
        unbanked: [
          { amount: 300, paymentMethod: "COURIER_COLLECTION", isCourierCollection: true },
          { amount: 200, paymentMethod: "CASH", isCourierCollection: false },
          { amount: 150, paymentMethod: "BKASH", isCourierCollection: false },
          { amount: 50, paymentMethod: "NAGAD", isCourierCollection: false },
          { amount: 25, paymentMethod: "OTHER", isCourierCollection: false },
        ],
      }),
    ).toEqual({
      treasury: 1_000,
      courier: 300,
      cash: 200,
      bkash: 150,
      nagad: 50,
      other: 25,
      dueGross: 700,
      dueNet: 620,
      totalExcludingStock: 2_345,
    });
  });

  it("keeps a courier charge in the courier bucket as a negative asset", () => {
    const result = businessMoneyPosition({
      treasury: 500,
      dueGross: 0,
      dueNet: 0,
      unbanked: [{ amount: -65, paymentMethod: "CASH", isCourierCollection: false }],
    });
    expect(result.courier).toBe(-65);
    expect(result.cash).toBe(0);
    expect(result.totalExcludingStock).toBe(435);
  });
});
