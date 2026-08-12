import { describe, expect, it } from "vitest";
import { hasOwnAddress, orderRecipient, shipSnapshot } from "@/lib/order-recipient";

const customer = { name: "Rajib", phone: "01712345678", address: "Mirpur 14, Dhaka" };

describe("orderRecipient", () => {
  it("falls back to the customer when the order has no snapshot", () => {
    // Every order taken before the snapshot existed looks like this, and must
    // keep reading exactly as it did.
    expect(orderRecipient({ customer })).toEqual({
      name: "Rajib",
      phone: "01712345678",
      address: "Mirpur 14, Dhaka",
    });
  });

  it("prefers the order's own details over the customer record", () => {
    expect(
      orderRecipient({
        shipName: "Rajib Hasan",
        shipPhone: "01812345678",
        shipAddress: "Banani, Dhaka",
        customer,
      }),
    ).toEqual({ name: "Rajib Hasan", phone: "01812345678", address: "Banani, Dhaka" });
  });

  it("mixes the two field by field", () => {
    // A parcel sent to the office under the same name and number: overriding
    // the address must not blank out the rest.
    expect(orderRecipient({ shipAddress: "Gulshan 1, Dhaka", customer })).toEqual({
      name: "Rajib",
      phone: "01712345678",
      address: "Gulshan 1, Dhaka",
    });
  });

  it("treats whitespace-only snapshot fields as absent", () => {
    expect(orderRecipient({ shipAddress: "   ", customer }).address).toBe("Mirpur 14, Dhaka");
  });

  it("handles a walk-in with no customer at all", () => {
    expect(orderRecipient({})).toEqual({ name: null, phone: null, address: null });
  });

  it("still reports a walk-in's typed delivery details", () => {
    expect(orderRecipient({ shipName: "Ayna", shipAddress: "Uttara" })).toEqual({
      name: "Ayna",
      phone: null,
      address: "Uttara",
    });
  });

  it("returns null rather than an empty string for a missing field", () => {
    expect(orderRecipient({ customer: { name: "Ira", phone: null, address: null } })).toEqual({
      name: "Ira",
      phone: null,
      address: null,
    });
  });
});

describe("shipSnapshot", () => {
  const typed = { shipName: "Rajib", shipPhone: "01712345678", shipAddress: "Mirpur 14, Dhaka" };

  it("stores nothing when the parcel goes to the customer's own details", () => {
    expect(shipSnapshot(typed, customer)).toEqual({
      shipName: null,
      shipPhone: null,
      shipAddress: null,
    });
  });

  it("recognises the customer's number typed in another shape", () => {
    // The record holds 01712345678; these are the same number, so there is
    // nothing to snapshot — otherwise a corrected number would stop reaching
    // this order.
    for (const phone of ["+8801712345678", "01712 345678", "1712345678"]) {
      expect(shipSnapshot({ ...typed, shipPhone: phone }, customer).shipPhone).toBeNull();
    }
  });

  it("normalizes a genuinely different number, so the list can find it", () => {
    expect(shipSnapshot({ ...typed, shipPhone: "+880 1812-345678" }, customer).shipPhone).toBe(
      "01812345678",
    );
  });

  it("normalizes a walk-in's number, with no customer to compare against", () => {
    expect(shipSnapshot({ shipPhone: "+8801912345678" }, null)).toEqual({
      shipName: null,
      shipPhone: "01912345678",
      shipAddress: null,
    });
  });

  it("keeps a note in the phone field rather than losing it", () => {
    // Nothing to reshape and nothing worth dropping: whoever typed it meant it
    // to be read by a human.
    expect(shipSnapshot({ ...typed, shipPhone: "ask at the shop" }, customer).shipPhone).toBe(
      "ask at the shop",
    );
  });

  it("treats a blank phone as no snapshot", () => {
    expect(shipSnapshot({ ...typed, shipPhone: "   " }, customer).shipPhone).toBeNull();
  });

  it("still snapshots the name and address that differ", () => {
    expect(shipSnapshot({ ...typed, shipName: "Rajib Hasan", shipAddress: "Banani" }, customer))
      .toEqual({ shipName: "Rajib Hasan", shipPhone: null, shipAddress: "Banani" });
  });
});

describe("hasOwnAddress", () => {
  it("is false when the order has no snapshot", () => {
    expect(hasOwnAddress({ customer })).toBe(false);
  });

  it("is false when the snapshot matches the customer record", () => {
    expect(hasOwnAddress({ shipAddress: "Mirpur 14, Dhaka", customer })).toBe(false);
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(hasOwnAddress({ shipAddress: "  Mirpur 14, Dhaka  ", customer })).toBe(false);
  });

  it("is true when this parcel went somewhere else", () => {
    expect(hasOwnAddress({ shipAddress: "Banani, Dhaka", customer })).toBe(true);
  });

  it("is true when the customer record has no address of its own", () => {
    expect(
      hasOwnAddress({
        shipAddress: "Banani, Dhaka",
        customer: { name: "Ira", phone: null, address: null },
      }),
    ).toBe(true);
  });
});
