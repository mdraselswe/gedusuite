import { prisma } from "@/lib/prisma";
import {
  partnerBalances,
  businessCapitalSummary,
  supplierDues,
  treasuryBalance,
  operatingExpenses,
  totalBusinessProfit,
  overdueOrders,
  cashHeldByMember,
  totalDue,
  paidNotDeposited,
} from "@/lib/finance";
import { inventoryValue, variantStockMap } from "@/lib/inventory";
import { buildReport } from "@/lib/reports";
import { buildProductReport } from "@/lib/product-report";
import { dhakaDayEnd, dhakaDayStart } from "@/lib/dhaka-time";

/**
 * Turn any figure object into plain, id-free, order-stable JSON so two runs of
 * the same dataset compare byte-for-byte. Random cuid ids are dropped (they
 * differ per run); money is rounded to the paisa; Maps become objects.
 */
function normalise(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v) o[String(k)] = normalise(val);
    return o;
  }
  if (typeof v === "object" && v !== null && "toNumber" in v && typeof (v as { toNumber: unknown }).toNumber === "function") {
    return Math.round((v as { toNumber(): number }).toNumber() * 100) / 100;
  }
  if (Array.isArray(v)) {
    const items = v.map(normalise);
    // Rows that tie on date come back in database order, which follows random
    // ids. The figures are the same set of rows either way, so compare sets.
    return items.every((x) => typeof x === "object" && x !== null)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) {
    // A return's date defaults to the database clock at the moment it is
    // recorded, which is wall-clock time, not part of the dataset.
    if (k === "returns" && Array.isArray((v as Record<string, unknown>)[k])) {
      o[k] = normalise(
        ((v as Record<string, unknown>)[k] as Record<string, unknown>[]).map((r) => {
          const { date: _date, ...rest } = r;
          void _date;
          return rest;
        }),
      );
      continue;
    }
    if (k === "id" || k.endsWith("Id") || k === "userId") continue;
    // Stamped by the database clock at insert time — differs every run.
    if (["entered", "time", "dateInput", "createdAt", "updatedAt"].includes(k)) continue;
    o[k] = normalise((v as Record<string, unknown>)[k]);
  }
  return o;
}

export async function computeFigures(workspaceId: string, range: { from: string; to: string }) {
  const r = { from: dhakaDayStart(range.from), to: dhakaDayEnd(range.to) };

  // Partner names make the per-partner map readable and id-independent.
  const partners = await prisma.partner.findMany({
    where: { workspaceId },
    select: { id: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(partners.map((p) => [p.id, p.user.name ?? p.id]));
  const balances = await partnerBalances(workspaceId);
  const balancesByName: Record<string, unknown> = {};
  for (const [pid, b] of balances) balancesByName[nameOf.get(pid) ?? pid] = normalise(b);

  const variants = await prisma.productVariant.findMany({
    where: { product: { workspaceId } },
    select: { id: true, attributes: true, product: { select: { name: true } } },
  });
  const stockMap = await variantStockMap(workspaceId);
  const stock: Record<string, number> = {};
  for (const v of variants) {
    const label = `${v.product.name} / ${JSON.stringify(v.attributes)}`;
    stock[label] = stockMap.get(v.id) ?? 0;
  }

  const products = await prisma.product.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const productReports: Record<string, unknown> = {};
  for (const p of products) productReports[p.name] = normalise(await buildProductReport(workspaceId, p.id, r));

  return normalise({
    partnerBalances: balancesByName,
    capital: await businessCapitalSummary(workspaceId),
    supplierDues: await supplierDues(workspaceId),
    treasuryBalance: await treasuryBalance(workspaceId),
    operatingExpensesAll: await operatingExpenses(workspaceId, null),
    operatingExpensesRange: await operatingExpenses(workspaceId, r),
    businessProfit: await totalBusinessProfit(workspaceId),
    overdue: await overdueOrders(workspaceId),
    cashHeld: await cashHeldByMember(workspaceId),
    customerDue: await totalDue(workspaceId),
    paidNotDeposited: await paidNotDeposited(workspaceId),
    inventoryValue: await inventoryValue(workspaceId),
    stock,
    reportAllTime: await buildReport(workspaceId, null),
    reportRange: await buildReport(workspaceId, r),
    productReports,
  });
}
