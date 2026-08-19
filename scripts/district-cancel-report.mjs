/**
 * Cancellations by district — where the parcels are coming back from.
 *
 * Read-only. Counts every order against `shipDistrict` (best-effort, tagged at
 * booking time — see the column's note in schema.prisma) and splits it by
 * status, so a district's cancel rate can be read next to the volume it is a
 * rate of. Orders with no district tag are grouped as "(untagged)" rather than
 * dropped, because pretending they do not exist would flatter every rate above.
 *
 * Cancel COUNT is what a small sample can support; the RATE column is only
 * meaningful once a district has a handful of orders, so anything under the
 * minimum is printed but marked.
 *
 *   node -r dotenv/config scripts/district-cancel-report.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/district-cancel-report.mjs 2026-07-01 dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MIN_FOR_RATE = 5;
const since = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

const orders = await prisma.order.findMany({
  where: since ? { date: { gte: new Date(`${since}T00:00:00+06:00`) } } : {},
  select: {
    orderNo: true, date: true, status: true, shipDistrict: true,
    discount: true, deliveryCharge: true, courierStatus: true, returnLeg: true,
    deliveryType: true, courierZone: { select: { name: true } },
    items: { select: { unitPrice: true, quantity: true, discount: true } },
  },
  orderBy: { date: "asc" },
});

// Order has no `total` column — the app derives it from the lines, so do the same.
const orderTotal = (o) =>
  o.items.reduce((a, li) => a + Number(li.unitPrice) * li.quantity - Number(li.discount), 0) +
  Number(o.deliveryCharge) - Number(o.discount);

const money = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
console.log(`${orders.length} orders${since ? ` since ${since}` : " (all time)"}\n`);

const rows = new Map();
for (const o of orders) {
  const key = o.shipDistrict || "(untagged)";
  const r = rows.get(key) || { n: 0, cancelled: 0, delivered: 0, open: 0, lost: 0 };
  r.n++;
  if (o.status === "CANCELLED") { r.cancelled++; r.lost += orderTotal(o); }
  else if (o.status === "DELIVERED") r.delivered++;
  else r.open++;
  rows.set(key, r);
}

console.log("DISTRICT            ORD  CANC  DELIV  OPEN   CANCEL RATE   LOST BDT");
console.log("-".repeat(72));
const sorted = [...rows].sort((a, b) => b[1].cancelled - a[1].cancelled || b[1].n - a[1].n);
for (const [name, r] of sorted) {
  // A rate is only worth reading against a settled denominator: an order still
  // in flight has not had its chance to be refused yet.
  const settled = r.cancelled + r.delivered;
  const rate = settled ? `${Math.round((100 * r.cancelled) / settled)}%` : "—";
  const flag = settled < MIN_FOR_RATE ? " *" : "  ";
  console.log(
    `${name.padEnd(20)}${String(r.n).padStart(3)}${String(r.cancelled).padStart(6)}` +
    `${String(r.delivered).padStart(7)}${String(r.open).padStart(6)}` +
    `${(rate + flag).padStart(13)}${money(r.lost).padStart(11)}`,
  );
}
const tot = [...rows.values()].reduce(
  (a, r) => ({ n: a.n + r.n, c: a.c + r.cancelled, d: a.d + r.delivered, lost: a.lost + r.lost }),
  { n: 0, c: 0, d: 0, lost: 0 },
);
console.log("-".repeat(72));
console.log(
  `${"TOTAL".padEnd(20)}${String(tot.n).padStart(3)}${String(tot.c).padStart(6)}` +
  `${String(tot.d).padStart(7)}${String(tot.n - tot.c - tot.d).padStart(6)}` +
  `${((tot.c + tot.d ? `${Math.round((100 * tot.c) / (tot.c + tot.d))}%` : "—") + "  ").padStart(13)}` +
  `${money(tot.lost).padStart(11)}`,
);
console.log(`\n* fewer than ${MIN_FOR_RATE} settled orders — count is real, rate is noise.`);

// Zone is the coarser cut, and today the only one with enough orders behind it
// to mean anything: it comes off the courier rate band, so it is set on every
// parcel that was actually booked rather than guessed from an address.
const zones = new Map();
for (const o of orders) {
  const key = o.courierZone?.name || `(not booked — ${o.deliveryType})`;
  const z = zones.get(key) || { n: 0, cancelled: 0, delivered: 0 };
  z.n++;
  if (o.status === "CANCELLED") z.cancelled++;
  else if (o.status === "DELIVERED") z.delivered++;
  zones.set(key, z);
}
console.log("\n=== BY COURIER ZONE ===");
console.log("ZONE                        ORD  CANC  DELIV   CANCEL RATE");
for (const [name, z] of [...zones].sort((a, b) => b[1].n - a[1].n)) {
  const settled = z.cancelled + z.delivered;
  console.log(
    `${name.padEnd(28)}${String(z.n).padStart(3)}${String(z.cancelled).padStart(6)}` +
    `${String(z.delivered).padStart(7)}` +
    `${(settled ? `${Math.round((100 * z.cancelled) / settled)}%` : "—").padStart(14)}`,
  );
}

const cancelled = orders.filter((o) => o.status === "CANCELLED");
if (cancelled.length) {
  console.log("\n=== CANCELLED ORDERS ===");
  for (const o of cancelled) {
    console.log(
      `  ${o.orderNo}  ${o.date.toISOString().slice(0, 10)}  ` +
      `${(o.shipDistrict || "(untagged)").padEnd(16)} BDT ${money(orderTotal(o)).padStart(7)}  ` +
      `courier:${o.courierStatus || "—"}  return:${o.returnLeg}`,
    );
  }
}
await prisma.$disconnect();
