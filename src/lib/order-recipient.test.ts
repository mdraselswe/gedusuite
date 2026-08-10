import { describe, expect, it } from "vitest";
import { hasOwnAddress, orderRecipient } from "@/lib/order-recipient";

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
