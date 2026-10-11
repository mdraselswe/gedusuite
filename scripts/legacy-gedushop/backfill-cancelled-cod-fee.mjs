/**
 * One-off: give the already-cancelled orders the COD fee they were actually
 * charged.
 *
 * A partial delivery is money the courier collects, so it keeps its
 * percentage of it — but nothing ever quoted that fee. Orders cancelled
 * before this ran carry either a zero (the earlier courier backfill zeroed
 * every cancellation) or a fee quoted against the invoice that was never
 * delivered. Both are wrong in the same place: the treasury and the profit
 * figure both read this number.
 *
 * Cancelling now re-quotes it, so this only has to catch up the history.
 * Orders that collected nothing are left alone — there is no percentage of
 * nothing, and a zero there is already right.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/backfill-cancelled-cod-fee.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/backfill-cancelled-cod-fee.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const n = (v) => (v == null ? 0 : Number(v));

/** The app's own weight rule: couriers charge per STARTED kilo over the allowance. */
function weightCharge(courier, weightKg) {
  if (weightKg == null) return 0;
  const over = Number(weightKg) - n(courier.baseWeightKg);
  if (over <= 0) return 0;
  return round2(Math.ceil(over) * n(courier.extraKgRate));
}

async function main() {
  // Named explicitly for the same reason as the other backfills: this account
  // has more than one workspace, and "the first" is not an answer.
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

  const orders = await prisma.order.findMany({
    where: { workspaceId: workspace.id, status: "CANCELLED" },
    orderBy: { date: "asc" },
    include: {
      customer: { select: { name: true } },
      courier: { include: { zones: true } },
    },
  });

  console.log(`Workspace: ${workspace.name}`);
  console.log(`Cancelled orders: ${orders.length}`);
  console.log(`Mode:      ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  const plans = [];
  for (const o of orders) {
    const name = o.customer?.name ?? "Walk-in";
    const collected = n(o.cancelledCollected);
    const stored = n(o.codFeeCost);

    // Only what the courier itself hands over carries the fee.
    const collects = o.paymentMethod === "COURIER_COLLECTION" && collected > 0;
    if (!collects) {
      plans.push({ o, name, collected, stored, fee: 0, note: "nothing collected by courier" });
      continue;
    }
    if (!o.courier) {
      plans.push({ o, name, collected, stored, skip: "no courier on the order" });
      continue;
    }

    // NET takes the percentage off what is left once the courier's own
    // delivery charge is out, and that charge comes from the zone — the same
    // quote the app runs, not the delivery cost typed on the cancellation.
    const zone = o.courierZoneId ? o.courier.zones.find((z) => z.id === o.courierZoneId) : null;
    if (o.courier.codFeeBase === "NET" && !zone) {
      plans.push({ o, name, collected, stored, skip: "NET fee needs the zone, none set" });
      continue;
    }
    const quotedDelivery = zone ? round2(n(zone.rate) + weightCharge(o.courier, o.weightKg)) : 0;
    const base =
      o.courier.codFeeBase === "GROSS" ? collected : Math.max(0, collected - quotedDelivery);
    const fee = round2((base * n(o.courier.codFeePercent)) / 100);
    plans.push({ o, name, collected, stored, fee });
  }

  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);
  console.log(
    `${pad("Date", 12)}${pad("Customer", 24)}${padL("Collected", 10)}${padL("Stored", 9)}${padL("Fee", 9)}  Note`,
  );
  const writes = [];
  for (const p of plans) {
    const date = p.o.date.toISOString().slice(0, 10);
    if (p.skip) {
      console.log(
        `${pad(date, 12)}${pad(p.name, 24)}${padL(p.collected, 10)}${padL(p.stored, 9)}${padL("—", 9)}  SKIP: ${p.skip}`,
      );
      continue;
    }
    const changed = round2(p.stored) !== round2(p.fee);
    console.log(
      `${pad(date, 12)}${pad(p.name, 24)}${padL(p.collected, 10)}${padL(p.stored, 9)}${padL(p.fee, 9)}  ${
        changed ? "→ update" : "ok"
      }${p.note ? ` (${p.note})` : ""}`,
    );
    if (changed) writes.push({ id: p.o.id, codFeeCost: p.fee });
  }

  console.log(`\n${writes.length} order(s) to update.`);
  if (!APPLY) {
    console.log("Dry run — nothing written. Re-run with --apply.");
    return;
  }
  for (const w of writes) {
    await prisma.order.update({ where: { id: w.id }, data: { codFeeCost: w.codFeeCost } });
  }
  console.log("Done.");
  // The treasury entry for a cancelled order is net of the courier's charges,
  // so a changed fee moves the deposit with it. resync-order-deposits.mjs is
  // the script that recomputes those — run it after this one.
  console.log("Now run scripts/resync-order-deposits.mjs so the deposits follow the new fee.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
