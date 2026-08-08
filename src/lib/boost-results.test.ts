import { describe, expect, it } from "vitest";
import { buildCampaignResult, type AttributableOrder } from "@/lib/boost-results";

const day = (d: string) => new Date(`${d}T06:00:00.000Z`);

const campaign = {
  id: "c1",
  name: "August boost",
  channel: "FACEBOOK",
  window: { from: day("2026-08-01"), to: day("2026-08-31") },
};

let seq = 0;
const sold = (over: Partial<AttributableOrder> = {}): AttributableOrder => ({
  id: `o${++seq}`,
  date: day("2026-08-05"),
  customerName: "Asha",
  source: "FACEBOOK",
  boostCampaignId: "c1",
  netRevenue: 1000,
  netProfit: 250,
  cancelled: false,
  ...over,
});

const cancelled = (over: Partial<AttributableOrder> = {}): AttributableOrder =>
  sold({ netRevenue: 0, netProfit: -115, cancelled: true, ...over });

describe("buildCampaignResult — channel split", () => {
  it("adds up to the headline profit, cancellations included", () => {
    // The bug this exists to stop: filtering cancellations out of the split
    // left the rows claiming more profit than the campaign made, by exactly
    // what the refused parcels cost.
    const r = buildCampaignResult(campaign, [sold(), sold(), cancelled()], 500);
    const rowProfit = r.byChannel.reduce((s, c) => s + c.profit, 0);
    expect(rowProfit).toBe(r.profit);
    expect(r.profit).toBe(385); // 250 + 250 − 115
  });

  it("counts a cancellation in its own column, not as an order", () => {
    const r = buildCampaignResult(campaign, [sold(), cancelled()], 0);
    const row = r.byChannel[0];
    expect(row.orders).toBe(1);
    expect(row.cancelledOrders).toBe(1);
    expect(row.cancelledCost).toBe(115);
    // Nothing was sold on the cancelled one, so revenue is the sold order's.
    expect(row.revenue).toBe(1000);
  });

  it("keeps each channel's cancellations on its own row", () => {
    // The point of splitting them: two channels can look alike on revenue and
    // be nothing alike on whether the parcels stay delivered.
    const r = buildCampaignResult(
      campaign,
      [
        sold({ source: "FACEBOOK" }),
        cancelled({ source: "FACEBOOK" }),
        cancelled({ source: "FACEBOOK" }),
        sold({ source: "WEBSITE" }),
      ],
      0,
    );
    const fb = r.byChannel.find((c) => c.source === "FACEBOOK");
    const web = r.byChannel.find((c) => c.source === "WEBSITE");
    expect(fb?.cancelledOrders).toBe(2);
    expect(web?.cancelledOrders).toBe(0);
    expect(fb?.revenue).toBe(web?.revenue); // identical revenue…
    expect(fb?.profit).toBe(20); // …and 230 of it eaten by returns
    expect(web?.profit).toBe(250);
  });

  it("reports no cancellations as zero rather than omitting the field", () => {
    const r = buildCampaignResult(campaign, [sold()], 0);
    expect(r.byChannel[0].cancelledOrders).toBe(0);
    expect(r.byChannel[0].cancelledCost).toBe(0);
  });
});

describe("buildCampaignResult — attributed order list", () => {
  it("lists exactly the orders the headline was computed from", () => {
    // An order outside the window and tagged to nobody is not this campaign's,
    // and must not appear in a list that claims to explain its numbers.
    const mine = sold({ boostCampaignId: "c1" });
    const stranger = sold({ boostCampaignId: null, date: day("2026-09-20") });
    const r = buildCampaignResult(campaign, [mine, stranger], 0, day("2026-09-30"));
    expect(r.attributedOrders.map((o) => o.id)).toEqual([mine.id]);
    expect(r.attributedOrders.length).toBe(r.orders + r.cancelledOrders);
  });

  it("keeps cancellations in the list and marks them", () => {
    const r = buildCampaignResult(campaign, [sold(), cancelled()], 0);
    const row = r.attributedOrders.find((o) => o.cancelled);
    expect(row).toBeDefined();
    expect(row?.revenue).toBe(0);
    expect(row?.profit).toBe(-115);
  });

  it("puts the newest order first", () => {
    const older = sold({ date: day("2026-08-02") });
    const newer = sold({ date: day("2026-08-20") });
    const r = buildCampaignResult(campaign, [older, newer], 0);
    expect(r.attributedOrders.map((o) => o.date)).toEqual(["2026-08-20", "2026-08-02"]);
  });

  it("names a walk-in rather than leaving the cell blank", () => {
    const r = buildCampaignResult(campaign, [sold({ customerName: null })], 0);
    expect(r.attributedOrders[0].customerName).toBe("Walk-in");
  });
});
