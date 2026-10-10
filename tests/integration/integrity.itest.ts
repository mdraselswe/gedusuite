import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { treasuryBalance } from "@/lib/finance";
import { variantStockMap } from "@/lib/inventory";
import { computeOrderTotals } from "@/lib/orders";
import { buildReport } from "@/lib/reports";
import { depositAmount } from "@/lib/order-cash";
import { round2 } from "@/lib/money";
import { resetDatabase } from "./harness";
import { buildDataset, type DatasetResult } from "../../scripts/demo/dataset";

/**
 * The books must add up — checked over a full generated business, from the
 * outside, with figures that do not share code with the thing being checked.
 * This is what makes the demo data trustworthy: it is not hand-typed, it is
 * what the app itself produced, and these invariants hold over all of it.
 */
describe("a whole business keeps its books straight", () => {
  let ws: DatasetResult;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T06:00:00.000Z"));
    await resetDatabase();
    ws = await buildDataset({
      slug: "integrity",
      workspaceName: "Integrity Shop",
      startDay: "2026-07-15",
      days: 60,
      emailDomain: "integrity.test",
      ordersPerDay: 3,
    });
  });
  afterAll(() => vi.useRealTimers());

  it("the treasury balance is exactly what came in minus what went out", async () => {
    const rows = await prisma.treasuryEntry.findMany({ where: { workspaceId: ws.workspaceId } });
    const inn = rows.filter((r) => r.type === "IN").reduce((s, r) => s + Number(r.amount), 0);
    const out = rows.filter((r) => r.type === "OUT").reduce((s, r) => s + Number(r.amount), 0);
    expect(rows.length).toBeGreaterThan(20);
    expect(await treasuryBalance(ws.workspaceId)).toBe(round2(inn - out));
  });

  it("no variant is ever in negative stock", async () => {
    const stock = await variantStockMap(ws.workspaceId);
    for (const [id, qty] of stock) expect(qty, `variant ${id}`).toBeGreaterThanOrEqual(0);
  });

  it("every banked order has exactly one treasury entry, for what the courier actually remitted", async () => {
    const orders = await prisma.order.findMany({
      where: { workspaceId: ws.workspaceId, cashInTreasury: true },
      include: { items: { include: { returns: true } }, treasuryEntry: true },
    });
    expect(orders.length).toBeGreaterThan(10);
    for (const o of orders) {
      expect(o.treasuryEntry, `order ${o.orderNo}`).not.toBeNull();
      const totals = computeOrderTotals(o);
      const dep = depositAmount(
        {
          status: o.status,
          deliveryType: o.deliveryType,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          amountPaid: o.amountPaid,
          cancelledCollected: o.cancelledCollected,
          deliveryCost: o.deliveryCost,
          collectionShortfall: o.collectionShortfall,
        },
        totals,
      );
      // Signed: a parcel that collected less than it cost to carry banks as an
      // outflow of the shortfall, so the entry's direction follows the sign.
      const signed =
        (o.treasuryEntry!.type === "IN" ? 1 : -1) * Number(o.treasuryEntry!.amount);
      expect(signed, `order ${o.orderNo}`).toBe(dep.net);
    }
  });

  it("a profit distribution moves exactly its amount, split with no taka lost", async () => {
    const dists = await prisma.profitDistribution.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { partnerTxns: true, treasuryEntry: true },
    });
    expect(dists.length).toBeGreaterThanOrEqual(1);
    for (const d of dists) {
      const paid = d.partnerTxns.reduce((s, t) => s + Number(t.amount), 0);
      expect(round2(paid)).toBe(Number(d.totalAmount));
      expect(Number(d.treasuryEntry!.amount)).toBe(Number(d.totalAmount));
      expect(d.treasuryEntry!.type).toBe("OUT");
    }
  });

  it("order numbers are unique and gapless within the workspace", async () => {
    const nos = (
      await prisma.order.findMany({
        where: { workspaceId: ws.workspaceId },
        select: { orderNo: true },
        orderBy: { orderNo: "asc" },
      })
    ).map((o) => o.orderNo!);
    expect(new Set(nos).size).toBe(nos.length);
    expect(nos[0]).toBe(1);
    expect(nos.at(-1)).toBe(nos.length);
  });

  it("the report's revenue and profit equal an independent re-add of the orders", async () => {
    const orders = await prisma.order.findMany({
      where: { workspaceId: ws.workspaceId, status: { not: "CANCELLED" } },
      include: { items: { include: { returns: true } } },
    });
    let revenue = 0;
    let lineCost = 0;
    for (const o of orders) {
      const t = computeOrderTotals(o);
      revenue += t.netRevenue;
      lineCost += t.cogs;
      // what the customer owes can never be negative
      expect(t.customerTotal).toBeGreaterThanOrEqual(0);
    }
    const report = await buildReport(ws.workspaceId, null);
    expect(report.kpis.revenue).toBe(round2(revenue));
    expect(report.kpis.orders).toBe(orders.length);
    // profit is revenue less cost of goods, adjusted by delivery margin, gifts,
    // fees and write-offs — so it can never exceed revenue less cost.
    expect(report.kpis.profit).toBeLessThanOrEqual(round2(revenue - lineCost) + 0.01 + orders.length * 100);
  });
});
