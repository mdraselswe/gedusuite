import { describe, expect, it } from "vitest";
import { goodsLikelyWithCourier, returnShortfalls } from "./returns";

/**
 * The receive step is the only place in the app where a number somebody typed
 * moves stock directly — everywhere else the shelf is derived from purchases
 * and orders. So the arithmetic here is what stands between a miscounted
 * parcel and a phantom that nobody can trace afterwards.
 */
describe("returnShortfalls", () => {
  const order = {
    items: [
      { id: "i1", productVariantId: "v1", quantity: 3 },
      { id: "i2", productVariantId: "v2", quantity: 1 },
    ],
    gifts: [
      { id: "g1", productVariantId: "v1", quantity: 1 },
      // A free-text gift: no variant, so no stock to put back.
      { id: "g2", productVariantId: null, quantity: 1 },
    ],
  };

  it("writes nothing off when the whole parcel came back", () => {
    const res = returnShortfalls(order, [
      { kind: "ITEM", id: "i1", good: 3 },
      { kind: "ITEM", id: "i2", good: 1 },
      { kind: "GIFT", id: "g1", good: 1 },
    ]);
    expect(res).toMatchObject({ ok: true, rows: [], total: 5 });
  });

  it("writes off only the part that didn't survive", () => {
    const res = returnShortfalls(order, [
      { kind: "ITEM", id: "i1", good: 1 },
      { kind: "ITEM", id: "i2", good: 1 },
      { kind: "GIFT", id: "g1", good: 1 },
    ]);
    expect(res).toMatchObject({ ok: true, rows: [{ productVariantId: "v1", quantity: 2 }] });
  });

  it("adds up two lines of the same variant", () => {
    // The item and the gift are the same product. Two adjustments for one
    // variant would both be right and the pair would read as a double count.
    const res = returnShortfalls(order, [
      { kind: "ITEM", id: "i1", good: 0 },
      { kind: "GIFT", id: "g1", good: 0 },
    ]);
    expect(res).toMatchObject({ ok: true, rows: [{ productVariantId: "v1", quantity: 4 }] });
  });

  it("treats a line left out as having come back whole", () => {
    // Somebody edits the one damaged row and submits. The lines they didn't
    // touch must not be written off.
    const res = returnShortfalls(order, [{ kind: "ITEM", id: "i2", good: 0 }]);
    expect(res).toMatchObject({ ok: true, rows: [{ productVariantId: "v2", quantity: 1 }] });
  });

  it("counts the whole parcel in the total, not just the lines given", () => {
    const res = returnShortfalls(order, [{ kind: "ITEM", id: "i2", good: 1 }]);
    // 3 + 1 + 1: the free-text gift has no stock and so no place in this sum.
    expect(res).toMatchObject({ ok: true, total: 5 });
  });

  it("refuses more coming back than went out", () => {
    const res = returnShortfalls(order, [{ kind: "ITEM", id: "i1", good: 4 }]);
    expect(res.ok).toBe(false);
  });

  it("refuses a line the parcel never carried", () => {
    const res = returnShortfalls(order, [{ kind: "ITEM", id: "nope", good: 1 }]);
    expect(res.ok).toBe(false);
  });

  it("refuses a free-text gift, which has no stock to restore", () => {
    const res = returnShortfalls(order, [{ kind: "GIFT", id: "g2", good: 0 }]);
    expect(res.ok).toBe(false);
  });

  it("refuses the same line twice", () => {
    // Sent twice at 0 each, this would otherwise write off six of a parcel
    // that only carried three.
    const res = returnShortfalls(order, [
      { kind: "ITEM", id: "i1", good: 0 },
      { kind: "ITEM", id: "i1", good: 0 },
    ]);
    expect(res.ok).toBe(false);
  });

  it("does not confuse an item and a gift sharing an id", () => {
    const shared = {
      items: [{ id: "x", productVariantId: "v1", quantity: 2 }],
      gifts: [{ id: "x", productVariantId: "v2", quantity: 1 }],
    };
    const res = returnShortfalls(shared, [{ kind: "GIFT", id: "x", good: 0 }]);
    expect(res).toMatchObject({ ok: true, rows: [{ productVariantId: "v2", quantity: 1 }] });
  });
});

/**
 * Only the tick box's starting position — the person cancelling can always
 * say otherwise. It is worth pinning down anyway: ticked when the goods are
 * on the shelf holds stock back for nothing, and unticked when they aren't
 * offers pieces that are in a van.
 */
describe("goodsLikelyWithCourier", () => {
  const courier = { deliveryType: "COURIER", courierTrackingId: "CN-1" };

  it("assumes a shipped parcel is with the courier", () => {
    expect(goodsLikelyWithCourier({ ...courier, status: "SHIPPED" })).toBe(true);
  });

  it("assumes a packed and booked parcel has been collected", () => {
    expect(goodsLikelyWithCourier({ ...courier, status: "PACKED" })).toBe(true);
  });

  it("leaves a packed parcel with no consignment number on the shelf", () => {
    // Boxed and still on the table: nothing has left the shop.
    expect(
      goodsLikelyWithCourier({ ...courier, status: "PACKED", courierTrackingId: null }),
    ).toBe(false);
  });

  it("never assumes it of a hand delivery", () => {
    // There is no courier to be holding it, whatever the status says.
    expect(
      goodsLikelyWithCourier({ status: "SHIPPED", deliveryType: "SELF", courierTrackingId: null }),
    ).toBe(false);
  });

  it("leaves an unpacked order alone", () => {
    expect(goodsLikelyWithCourier({ ...courier, status: "CONFIRMED" })).toBe(false);
  });
});
