/**
 * One-off: give the orders that predate courier rules the costs they always
 * had.
 *
 * Every courier order was recorded as two numbers — what the customer paid
 * and what the courier charged — and the percentage fee the courier keeps was
 * never anywhere. This fills in codFeeCost, points each order at the courier
 * and zone that carried it, and writes the delivery cost for the parcels that
 * were sent before anyone was recording one.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/backfill-courier-costs.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/backfill-courier-costs.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const n = (v) => (v == null ? 0 : Number(v));

/**
 * Delivery charges read off the courier's own parcel list for orders that
 * hadn't been costed here yet. Keyed by customer name because these parcels
 * predate the tracking id being recorded.
 */
const KNOWN_CHARGES = [
  ["MD aminul Islam", 115],
  ["সিদরাতুল মুনতাহা", 115],
  ["Jahan Tofa", 115],
  ["Habibur Rahman Rony", 65],
  ["Kowshik", 115],
  ["রাজিব হোসেন", 115],
];

/**
 * The courier collected less than this order says it was worth: the parcel
 * was booked with a different delivery charge than the one recorded here.
 * Correcting the charge makes the order match what actually happened — and
 * the COD fee is a percentage of it, so it has to be right first.
 */
const COD_CORRECTIONS = [{ match: "সাথী", deliveryCharge: 50, actualCod: 890 }];

async function main() {
  // Named explicitly: this account has more than one workspace, and picking
  // "the first" quietly backfilled the wrong shop's orders — with nothing to
  // find, so it looked like a missing courier rather than a wrong target.
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const slug = slugArg ? slugArg.slice("--slug=".length) : "gedushop";
  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!workspace) {
    console.log(`No workspace with slug "${slug}". Pass --slug=<your-workspace>.`);
    return;
  }
  const workspaceId = workspace.id;

  const courier = await prisma.courier.findFirst({
    where: { workspaceId, isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { zones: true },
  });
  if (!courier) {
    console.log("No courier set up yet — add one on Settings → Couriers first.");
    return;
  }
  const pct = Number(courier.codFeePercent);
  const base = courier.codFeeBase;

  const orders = await prisma.order.findMany({
    where: { workspaceId, deliveryType: "COURIER" },
    orderBy: { date: "asc" },
    include: { customer: { select: { name: true } }, items: { include: { returns: true } } },
  });

  console.log(`Workspace: ${workspace.name}`);
  console.log(`Courier:   ${courier.name} — ${pct}% on ${base}`);
  console.log(`Zones:     ${courier.zones.map((z) => `${z.name} ${Number(z.rate)}`).join(", ")}`);
  console.log(`Mode:      ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  const plans = [];
  for (const o of orders) {
    const name = o.customer?.name ?? "Walk-in";

    // Effective revenue: returned units drop out, the same way the app's own
    // totals treat them.
    let goods = 0;
    for (const it of o.items) {
      const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
      const qty = Math.max(0, it.quantity - returned);
      const fraction = it.quantity > 0 ? qty / it.quantity : 0;
      goods += n(it.unitPrice) * qty - n(it.discount) * fraction;
    }
    goods = round2(goods - n(o.discount));

    const correction = COD_CORRECTIONS.find((c) => name.includes(c.match));
    const deliveryCharge = correction ? correction.deliveryCharge : n(o.deliveryCharge);

    // What the courier charged. Already recorded for most; taken from the
    // courier's parcel list for the ones sent before that was tracked.
    const known = KNOWN_CHARGES.find(([who]) => name.includes(who));
    const deliveryCost = o.deliveryCost != null ? n(o.deliveryCost) : known ? known[1] : null;
    if (deliveryCost == null) {
      plans.push({ o, name, skip: "no courier charge known — set it by hand" });
      continue;
    }

    const cod = round2(goods + deliveryCharge);
    // Only what the courier itself collects carries the fee.
    const collects = o.paymentMethod === "COURIER_COLLECTION";
    const feeBase = base === "GROSS" ? cod : Math.max(0, cod - deliveryCost);
    const codFee = collects && o.status !== "CANCELLED" ? round2((feeBase * pct) / 100) : 0;

    const zone = courier.zones.find((z) => Number(z.rate) === deliveryCost) ?? null;

    plans.push({
      o,
      name,
      deliveryCharge,
      deliveryCost,
      cod,
      codFee,
      zone,
      changes: {
        ...(correction && n(o.deliveryCharge) !== deliveryCharge
          ? { deliveryCharge }
          : {}),
        ...(o.deliveryCost == null ? { deliveryCost } : {}),
        ...(n(o.codFeeCost) !== codFee ? { codFeeCost: codFee } : {}),
        ...(o.courierId !== courier.id ? { courierId: courier.id } : {}),
        ...(zone && o.courierZoneId !== zone.id ? { courierZoneId: zone.id } : {}),
      },
    });
  }

  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);
  console.log(
    pad("Customer", 22) + pad("Date", 12) + padL("COD", 9) + padL("Charge", 8) +
      padL("COD fee", 9) + "  " + pad("Zone", 16) + "What changes",
  );
  console.log("-".repeat(110));

  let feeTotal = 0;
  let changed = 0;
  for (const p of plans) {
    if (p.skip) {
      console.log(pad(p.name, 22) + pad(p.o.date.toISOString().slice(0, 10), 12) + padL("—", 9) + padL("—", 8) + padL("—", 9) + "  " + pad("—", 16) + `SKIP: ${p.skip}`);
      continue;
    }
    const keys = Object.keys(p.changes);
    if (keys.length) changed += 1;
    feeTotal += p.codFee;
    console.log(
      pad(p.name, 22) +
        pad(p.o.date.toISOString().slice(0, 10), 12) +
        padL(p.cod.toFixed(2), 9) +
        padL(p.deliveryCost.toFixed(2), 8) +
        padL(p.codFee.toFixed(2), 9) +
        "  " +
        pad(p.zone ? p.zone.name : "(rate not in table)", 16) +
        (keys.length ? keys.join(", ") : "nothing"),
    );
  }

  console.log("-".repeat(110));
  console.log(`${changed} order(s) would change. COD fees total ${round2(feeTotal).toFixed(2)}.`);
  console.log(
    `Profit across these orders drops by that amount — it was always being paid, just never recorded.`,
  );

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to save.");
    return;
  }

  let written = 0;
  for (const p of plans) {
    if (p.skip || Object.keys(p.changes).length === 0) continue;
    await prisma.order.update({ where: { id: p.o.id }, data: p.changes });
    written += 1;
  }
  console.log(`\nWrote ${written} order(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
