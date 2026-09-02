import { describe, expect, it } from "vitest";
import { cartItemsText, normalisePhone, ABANDON_AFTER_MS } from "@/lib/abandoned-cart";

describe("normalisePhone", () => {
  it("keeps one row per person however they typed the number", () => {
    // All four are one customer. The key they collapse to is what stops a
    // second visit from opening a second row beside the first.
    for (const written of ["01712345678", "01712-345678", "01712 345678", "+8801712345678"]) {
      expect(normalisePhone(written)).toBe("01712345678");
    }
  });

  it("rejects a number that is still being typed", () => {
    // The beacon fires on every keystroke, so most of what reaches this is a
    // half-finished number. Each must be refused, not stored as its own lead.
    for (const partial of ["0", "017", "0171234567", ""]) {
      expect(normalisePhone(partial)).toBeNull();
    }
  });

  it("rejects things shaped like a number but not callable", () => {
    expect(normalisePhone("01212345678")).toBeNull(); // no such operator prefix
    expect(normalisePhone("017123456789")).toBeNull(); // one digit too many
    expect(normalisePhone("hello")).toBeNull();
  });

  it("survives a country code with punctuation around it", () => {
    expect(normalisePhone("+880 1712-345678")).toBe("01712345678");
  });

  it("restores a leading zero somebody left off", () => {
    // Forms drop it constantly, and lib/phone recovers it on purpose. Refusing
    // it here would file that person as a second, unmatched lead.
    expect(normalisePhone("1712345678")).toBe("01712345678");
  });
});

describe("cartItemsText", () => {
  it("reads as something to say down a phone line", () => {
    expect(
      cartItemsText([
        { name: "Magnatic Bar Blocks (42Pcs)", quantity: 2 },
        { name: "Zayan Talking Flash Cards", quantity: 1 },
      ]),
    ).toBe("Magnatic Bar Blocks (42Pcs) x2, Zayan Talking Flash Cards x1");
  });

  it("never prints a quantity that would confuse the caller", () => {
    // A missing or nonsense quantity is one item, not zero and not a fraction:
    // the customer put something in the basket either way.
    expect(cartItemsText([{ name: "Toy" }])).toBe("Toy x1");
    expect(cartItemsText([{ name: "Toy", quantity: 0 }])).toBe("Toy x1");
    expect(cartItemsText([{ name: "Toy", quantity: 2.7 }])).toBe("Toy x2");
  });

  it("falls back to a readable placeholder for a nameless line", () => {
    expect(cartItemsText([{ quantity: 3 }])).toBe("Item x3");
  });
});

describe("ABANDON_AFTER_MS", () => {
  it("is long enough that a customer still filling the form is not rung", () => {
    // The snapshot arrives mid-keystroke. Anything under a few minutes would
    // put people who are actively buying onto the call list.
    expect(ABANDON_AFTER_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ABANDON_AFTER_MS).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });
});
