import { describe, expect, it } from "vitest";
import {
  blockedByDepositedCash,
  cashEntryNote,
  cashEntrySource,
  amountCollected,
  amountOutstanding,
  collectionRecorded,
  courierChargeNote,
  deliveryCostCharged,
  depositAmount,
} from "@/lib/order-cash";

describe("blockedByDepositedCash", () => {
  it("lets an order with no banked cash through", () => {
    expect(blockedByDepositedCash({ cashInTreasury: false }, "delete")).toBeNull();
    expect(blockedByDepositedCash({ cashInTreasury: false }, "unpay")).toBeNull();
  });

  it("stops a delete that would orphan the treasury entry", () => {
    const msg = blockedByDepositedCash({ cashInTreasury: true }, "delete");
    expect(msg).toContain("delete this order");
    // The message has to say what to do, not just what it refused.
    expect(msg).toContain("Undo the deposit");
  });

  it("stops unpaying an order whose money is already in the treasury", () => {
    expect(blockedByDepositedCash({ cashInTreasury: true }, "unpay")).toContain(
      "mark this order unpaid",
    );
  });
});

describe("cashEntrySource", () => {
  it("names a courier remittance as one", () => {
    expect(cashEntrySource("COURIER_COLLECTION")).toBe("Courier remittance");
  });

  it("calls everything else a sales collection", () => {
    for (const m of ["CASH", "BKASH", "NAGAD", "OTHER"]) {
      expect(cashEntrySource(m)).toBe("Sales collection");
    }
  });
});

describe("cashEntryNote", () => {
  const customer = { name: "Asha" };
  const holder = { user: { name: "Rasel", email: "r@x.com" } };

  it("names the customer and who collected it", () => {
    expect(cashEntryNote({ customer, heldBy: holder }, 0)).toBe(
      "Order for Asha, collected by Rasel",
    );
  });

  it("falls back to the email when the holder has no name", () => {
    expect(
      cashEntryNote({ customer, heldBy: { user: { name: null, email: "r@x.com" } } }, 0),
    ).toContain("collected by r@x.com");
  });

  it("says walk-in when there's no customer", () => {
    expect(cashEntryNote({ customer: null, heldBy: null }, 0)).toBe("Walk-in order");
  });

  it("explains a figure that's lower than the invoice", () => {
    // Otherwise the treasury shows less than the order and nothing says why.
    expect(cashEntryNote({ customer, heldBy: null }, 2)).toBe(
      "Order for Asha, net of 2 returned unit(s)",
    );
  });

  it("says what the courier kept", () => {
    expect(cashEntryNote({ customer, heldBy: null }, 0, 73.45)).toBe(
      "Order for Asha, after 73.45 courier charges",
    );
  });

  it("says a cancellation is a cancellation", () => {
    // 4.95 banked against a 960 order reads as a mistake unless the entry says
    // the parcel came back and only the shipping was collected.
    expect(cashEntryNote({ status: "CANCELLED", customer, heldBy: null }, 0, 115.05)).toBe(
      "Order for Asha, cancelled — collected on a partial delivery, after 115.05 courier charges",
    );
  });
});

describe("depositAmount", () => {
  const totals = (over: Partial<{ customerTotal: number; deliveryCost: number; codFeeCost: number }> = {}) => ({
    customerTotal: 960,
    deliveryCost: 65,
    codFeeCost: 8.45,
    ...over,
  });

  it("banks only what the courier hands over on a COD order", () => {
    // 960 collected, 65 delivery + 8.45 fee kept — 886.55 arrives, and that is
    // the number the treasury has to hold.
    const d = depositAmount(
      { status: "DELIVERED", deliveryType: "COURIER", paymentStatus: "PAID", paymentMethod: "COURIER_COLLECTION", deliveryCost: 65 },
      totals(),
    );
    expect(d.gross).toBe(960);
    expect(d.courierCharges).toBe(73.45);
    expect(d.net).toBe(886.55);
  });

  it("banks the whole amount when the business collected it itself", () => {
    // The team member is holding all 960 and hands over all 960. The courier
    // bills its trip against its own account, and netting it here would
    // understate what that person owes the shop.
    for (const method of ["CASH", "BKASH", "NAGAD", "OTHER"]) {
      const d = depositAmount({ status: "DELIVERED", deliveryType: "COURIER", paymentStatus: "PAID", paymentMethod: method, deliveryCost: 65 }, totals());
      expect(d.courierCharges).toBe(0);
      expect(d.net).toBe(960);
    }
  });

  it("charges a parcel that collected nothing to the courier's account", () => {
    // A giveaway: the customer owes nothing, so there is no collection for the
    // courier to keep its 65 out of — it takes it off the shop's balance
    // instead. Reported as a deposit of zero, that money left the business
    // without ever leaving the treasury.
    const d = depositAmount(
      { status: "DELIVERED", deliveryType: "COURIER", paymentStatus: "PAID", paymentMethod: "CASH", deliveryCost: 65 },
      totals({ customerTotal: 0, codFeeCost: 0 }),
    );
    expect(d.gross).toBe(0);
    expect(d.courierCharges).toBe(65);
    expect(d.net).toBe(-65);
  });

  it("leaves a self-delivered order alone however it was paid", () => {
    // No courier, no courier charge — whatever computeOrderTotals reports for
    // the delivery cost belongs to whoever drove it, not to an account that
    // settles itself.
    const d = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PAID", paymentMethod: "CASH", deliveryCost: 65 },
      totals({ customerTotal: 0, codFeeCost: 0 }),
    );
    expect(d.courierCharges).toBe(0);
    expect(d.net).toBe(0);
  });

  it("banks only what a refused parcel still collected", () => {
    const d = depositAmount(
      {
        status: "CANCELLED",
        deliveryType: "COURIER",
        paymentStatus: "PAID",
        paymentMethod: "COURIER_COLLECTION",
        cancelledCollected: 120,
        deliveryCost: 65,
      },
      totals({ deliveryCost: 65, codFeeCost: 0 }),
    );
    expect(d.gross).toBe(120);
    expect(d.net).toBe(55);
  });

  it("reads a cancelled order's missing delivery cost as zero, not as the charge", () => {
    // computeOrderTotals would report the delivery CHARGE here. Nothing was
    // quoted by the courier, so nothing may be deducted.
    const d = depositAmount(
      {
        status: "CANCELLED",
        deliveryType: "COURIER",
        paymentStatus: "PAID",
        paymentMethod: "COURIER_COLLECTION",
        cancelledCollected: 120,
        deliveryCost: null,
      },
      totals({ deliveryCost: 65, codFeeCost: 0 }),
    );
    expect(d.courierCharges).toBe(0);
    expect(d.net).toBe(120);
  });

  it("goes negative when the return charge outruns what was collected", () => {
    // The shop owes the courier the difference, and it comes out of the next
    // payout. Floored at zero — as this was — the 55 was never anywhere: not in
    // the treasury, not on any list, only in the profit figure.
    const d = depositAmount(
      {
        status: "CANCELLED",
        deliveryType: "COURIER",
        paymentStatus: "PAID",
        paymentMethod: "COURIER_COLLECTION",
        cancelledCollected: 60,
        deliveryCost: 115,
      },
      totals({ deliveryCost: 115, codFeeCost: 0 }),
    );
    expect(d.net).toBe(-55);
  });
});

describe("collectionRecorded", () => {
  it("takes a PAID order's figure as final", () => {
    expect(collectionRecorded({ status: "DELIVERED", paymentStatus: "PAID" })).toBe(true);
  });

  it("takes any cancellation's figure as final", () => {
    // The cancel dialog asks for what was collected and what the courier
    // charged, so a blank there is an answer, not a gap.
    expect(collectionRecorded({ status: "CANCELLED", paymentStatus: "UNPAID" })).toBe(true);
  });

  it("counts a PARTIAL row that has a figure on it", () => {
    expect(
      collectionRecorded({ status: "DELIVERED", paymentStatus: "PARTIAL", amountPaid: 300 }),
    ).toBe(true);
  });

  it("refuses to read a blank PARTIAL row as 'collected nothing'", () => {
    // The one that matters: it only LOOKS like zero collected, and booking a
    // courier charge against it takes money out of the treasury on the strength
    // of a number nobody typed.
    expect(
      collectionRecorded({ status: "DELIVERED", paymentStatus: "PARTIAL", amountPaid: 0 }),
    ).toBe(false);
  });

  it("refuses an UNPAID order — its parcel is still out", () => {
    expect(collectionRecorded({ status: "SHIPPED", paymentStatus: "UNPAID" })).toBe(false);
  });
});

describe("courierChargeNote", () => {
  const customer = { name: "Asha" };

  it("says whose parcel and that nothing paid for it", () => {
    expect(courierChargeNote({ customer, heldBy: null }, 0)).toBe(
      "Courier charges on Asha's order, nothing was collected to cover them",
    );
  });

  it("says a returned parcel came back", () => {
    expect(courierChargeNote({ status: "CANCELLED", customer, heldBy: null }, 60)).toBe(
      "Courier charges on Asha's order, parcel came back, only 60.00 was collected to cover them",
    );
  });
});

describe("amountCollected / amountOutstanding", () => {
  const totals = { customerTotal: 5000 };

  it("treats PAID as the whole total whatever amountPaid says", () => {
    // Every order predating the column has amountPaid 0 and is still settled;
    // and a PAID order stays settled when a return lowers what was owed.
    const o = { status: "DELIVERED", paymentStatus: "PAID", amountPaid: 0 };
    expect(amountCollected(o, totals)).toBe(5000);
    expect(amountOutstanding(o, totals)).toBe(0);
  });

  it("collects nothing on an UNPAID order", () => {
    const o = { status: "DELIVERED", paymentStatus: "UNPAID", amountPaid: 0 };
    expect(amountCollected(o, totals)).toBe(0);
    expect(amountOutstanding(o, totals)).toBe(5000);
  });

  it("counts the advance on a PARTIAL order and chases only the rest", () => {
    // The whole point: 3,000 in hand on a 5,000 order is 2,000 due, not 5,000.
    const o = { status: "DELIVERED", paymentStatus: "PARTIAL", amountPaid: 3000 };
    expect(amountCollected(o, totals)).toBe(3000);
    expect(amountOutstanding(o, totals)).toBe(2000);
  });

  it("leaves an untouched PARTIAL row behaving exactly as before", () => {
    // No backfill was run, so every pre-existing PARTIAL has amountPaid 0 and
    // must go on reporting its full total as due.
    const o = { status: "DELIVERED", paymentStatus: "PARTIAL", amountPaid: 0 };
    expect(amountOutstanding(o, totals)).toBe(5000);
  });

  it("clamps an advance that overshoots the total", () => {
    const o = { status: "DELIVERED", paymentStatus: "PARTIAL", amountPaid: 9000 };
    expect(amountCollected(o, totals)).toBe(5000);
    expect(amountOutstanding(o, totals)).toBe(0);
  });

  it("owes nothing on a cancelled order, whatever was paid towards it", () => {
    const o = {
      status: "CANCELLED",
      paymentStatus: "PAID",
      amountPaid: 5000,
      cancelledCollected: 120,
    };
    expect(amountCollected(o, totals)).toBe(120);
    expect(amountOutstanding(o, totals)).toBe(0);
  });
});

describe("deposits that are already banked", () => {
  const totals = { customerTotal: 5000, deliveryCost: 0, codFeeCost: 0 };

  it("reads a PARTIAL row with no figure as unrecorded, not as zero collected", () => {
    // The trap: a legacy PARTIAL order whose cash was marked deposited. Read
    // literally it has collected nothing, and syncOrderCashEntry would delete a
    // treasury entry for money that genuinely arrived — triggered by any
    // routine edit elsewhere on the order.
    const d = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PARTIAL", amountPaid: 0, paymentMethod: "CASH" },
      totals,
    );
    expect(d.gross).toBe(0);
    expect(d.net).toBe(0);
  });

  it("still reaches zero honestly on a fully returned PAID order", () => {
    // Nothing is owed and nothing is held: this one really should clear.
    const d = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PAID", paymentMethod: "CASH" },
      { customerTotal: 0, deliveryCost: 0, codFeeCost: 0 },
    );
    expect(d.gross).toBe(0);
    expect(d.net).toBe(0);
  });

  it("shrinks when a payment correction says less was collected", () => {
    // Allowed to compute, but the caller must refuse it while the cash is
    // banked — a payment dropdown may not quietly take 2,000 out of the
    // treasury.
    const banked = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PAID", paymentMethod: "CASH" },
      totals,
    ).net;
    const next = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PARTIAL", amountPaid: 3000, paymentMethod: "CASH" },
      totals,
    ).net;
    expect(banked).toBe(5000);
    expect(next).toBe(3000);
    expect(next < banked).toBe(true);
  });

  it("grows without complaint when more money comes in", () => {
    const before = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PARTIAL", amountPaid: 3000, paymentMethod: "CASH" },
      totals,
    ).net;
    const after = depositAmount(
      { status: "DELIVERED", deliveryType: "SELF", paymentStatus: "PAID", paymentMethod: "CASH" },
      totals,
    ).net;
    expect(after > before).toBe(true);
  });
});

describe("deliveryCostCharged", () => {
  it("charges a delivered order the pass-through cost", () => {
    // computeOrderTotals reads a blank delivery cost as equal to the charge,
    // which is exactly right once the parcel has been delivered.
    expect(
      deliveryCostCharged({ status: "DELIVERED", deliveryCost: null }, { deliveryCost: 65 }),
    ).toBe(65);
  });

  it("charges a cancellation with no recorded courier bill nothing", () => {
    // Nothing was quoted, so nothing was charged. Assuming otherwise invents a
    // bill the courier never sent — and puts both the treasury and the courier
    // balance out by it.
    expect(
      deliveryCostCharged({ status: "CANCELLED", deliveryCost: null }, { deliveryCost: 65 }),
    ).toBe(0);
  });

  it("charges a cancellation what the courier actually billed", () => {
    expect(
      deliveryCostCharged({ status: "CANCELLED", deliveryCost: 115 }, { deliveryCost: 115 }),
    ).toBe(115);
  });
});
