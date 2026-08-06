import { describe, expect, it } from "vitest";
import { blockedByDepositedCash, cashEntryNote, cashEntrySource } from "@/lib/order-cash";

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
});
