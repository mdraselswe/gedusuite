import { describe, expect, it } from "vitest";
import { buildBuyerHistory, historyForLead } from "@/lib/buyer-history";

const customer = (id: string, phone: string | null, altPhone: string | null = null) => ({
  id,
  phone,
  altPhone,
});
const order = (id: string, customerId: string | null, status: string) => ({
  id,
  customerId,
  status,
});

describe("buildBuyerHistory", () => {
  it("counts a number's orders by outcome", () => {
    const h = buildBuyerHistory(
      [customer("c1", "01712345678")],
      [
        order("o1", "c1", "DELIVERED"),
        order("o2", "c1", "DELIVERED"),
        order("o3", "c1", "CANCELLED"),
        order("o4", "c1", "PENDING"),
      ],
    );
    expect(h.get("01712345678")).toEqual({ previous: 4, delivered: 2, cancelled: 1 });
  });

  it("matches numbers written differently for the same buyer", () => {
    // The whole point: +880 / 88 / dropped-leading-zero forms are one person,
    // and a repeat buyer who typed their number differently must not read as new.
    const h = buildBuyerHistory(
      [customer("c1", "+8801712345678")],
      [order("o1", "c1", "DELIVERED")],
    );
    expect(h.get("01712345678")?.previous).toBe(1);
  });

  it("counts an order once when it reaches a phone via alt as well as main", () => {
    const h = buildBuyerHistory(
      [customer("c1", "01712345678", "01712345678")],
      [order("o1", "c1", "DELIVERED")],
    );
    expect(h.get("01712345678")?.previous).toBe(1);
  });

  it("credits both numbers of a customer who has two", () => {
    const h = buildBuyerHistory(
      [customer("c1", "01712345678", "01812345678")],
      [order("o1", "c1", "CANCELLED")],
    );
    expect(h.get("01712345678")?.cancelled).toBe(1);
    expect(h.get("01812345678")?.cancelled).toBe(1);
  });

  it("merges duplicate customer rows sharing a number", () => {
    // Manual customer creation doesn't check for an existing phone, so two rows
    // for one number is reachable — the history must still read as one buyer.
    const h = buildBuyerHistory(
      [customer("c1", "01712345678"), customer("c2", "01712345678")],
      [order("o1", "c1", "DELIVERED"), order("o2", "c2", "CANCELLED")],
    );
    expect(h.get("01712345678")).toEqual({ previous: 2, delivered: 1, cancelled: 1 });
  });

  it("ignores orders with no customer", () => {
    const h = buildBuyerHistory([customer("c1", "01712345678")], [order("o1", null, "DELIVERED")]);
    expect(h.size).toBe(0);
  });
});

describe("historyForLead", () => {
  const histories = buildBuyerHistory(
    [customer("c1", "01712345678")],
    [
      order("o1", "c1", "DELIVERED"),
      order("o2", "c1", "CANCELLED"),
      order("o3", "c1", "PENDING"),
    ],
  );

  it("subtracts the order this lead itself became", () => {
    expect(historyForLead(histories, "01712345678", "o3", "PENDING")).toEqual({
      previous: 2,
      delivered: 1,
      cancelled: 1,
    });
  });

  it("subtracts the lead's own order from the outcome it belongs to", () => {
    expect(historyForLead(histories, "01712345678", "o2", "CANCELLED")).toEqual({
      previous: 2,
      delivered: 1,
      cancelled: 0,
    });
  });

  it("shows everything when the lead has no order entered yet", () => {
    expect(historyForLead(histories, "01712345678", null, null)?.previous).toBe(3);
  });

  it("returns null for a first-time buyer", () => {
    expect(historyForLead(histories, "01911111111", null, null)).toBeNull();
  });

  it("returns null when the only order is the lead's own", () => {
    // A brand-new customer whose order is already entered must not be badged
    // as returning.
    const single = buildBuyerHistory(
      [customer("c9", "01999999999")],
      [order("only", "c9", "PENDING")],
    );
    expect(historyForLead(single, "01999999999", "only", "PENDING")).toBeNull();
  });

  it("matches the lead's number however it was typed", () => {
    expect(historyForLead(histories, "+8801712345678", null, null)?.previous).toBe(3);
  });

  it("returns null for a blank phone", () => {
    expect(historyForLead(histories, "", null, null)).toBeNull();
  });
});
