/**
 * Put Steadfast's own price calculator into the rate table, instead of what
 * had been worked out from parcels one at a time.
 *
 * Reverse-engineering got two of them wrong. A 0.7kg Dhaka parcel was quoted
 * 85 against a real 75, because the per-kilo rate was being applied from half
 * a kilo instead of a whole one; and the first step was put at 250g when the
 * card puts it at 150g, so a 0.2kg parcel read 55 where it costs 65. Both were
 * found only because a balance disagreed weeks later.
 *
 * The card has thirteen rows per service and this writes two or three, because
 * above a kilo it rises by exactly the per-started-kilo rate the courier row
 * already carries — see steadfast-rates.test.ts, which checks every row of all
 * four services against the model rather than trusting that.
 *
 * Existing orders keep the delivery cost they were quoted at the time: what a
 * parcel cost is a fact about that parcel, and re-quoting history against a
 * table that has just changed would rewrite what the courier charged.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/load-steadfast-rate-card.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/load-steadfast-rate-card.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const WITH_EXPRESS = process.argv.includes("--with-express");
const prisma = new PrismaClient();

/** Only the steps below a kilo; extraKgRate covers everything above. */
const CARD = [
  { name: "Dhaka City", rate: 65, bands: [[0.15, 55], [0.5, 65], [1, 75]] },
  { name: "Dhaka Sub-urban", rate: 105, bands: [[1, 105]] },
  { name: "Outside Dhaka", rate: 115, bands: [[0.5, 115], [1, 135]] },
];
/** A different service rather than a different place — only if it's used. */
const EXPRESS = { name: "Dhaka City (Express)", rate: 105, bands: [[1, 105]] };

/**
 * A parcel whose weight was guessed twice before anybody read it.
 *
 * Steadfast charged 55. The old table read that as "under 250g" and 0.2 was
 * written down; the card puts the step at 150g, so 0.2 would have re-quoted to
 * 65 and disagreed with the bill, and 0.15 went down instead — the top of the
 * band that fits, which is a guess wearing a precise-looking number. The app
 * says 0.1. Both guesses quote 55, so no money moved either time; what moves
 * is whether this row can be trusted the next time somebody reasons from it.
 */
const REWEIGH = { tracking: "282719499", from: 0.15, to: 0.1 };

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const slug = slugArg ? slugArg.slice("--slug=".length) : "gedushop";
  const ws = await prisma.workspace.findFirst({ where: { slug } });
  if (!ws) throw new Error(`No workspace "${slug}"`);

  const courier = await prisma.courier.findFirst({
    where: { workspaceId: ws.id, name: "Steadfast" },
    include: { zones: { include: { bands: { orderBy: { uptoKg: "asc" } } } } },
  });
  if (!courier) throw new Error("No Steadfast courier");

  console.log(`Workspace ${slug} — ${APPLY ? "APPLYING" : "dry run"}\n`);
  if (Number(courier.extraKgRate) !== 20) {
    console.log(`!! extraKgRate is ${courier.extraKgRate}, the card needs 20 — not changed here`);
  }

  const wanted = WITH_EXPRESS ? [...CARD, EXPRESS] : CARD;
  for (const z of wanted) {
    const existing = courier.zones.find((e) => e.name === z.name);
    const was = existing
      ? existing.bands.map((b) => `≤${Number(b.uptoKg)}kg ৳${Number(b.rate)}`).join(", ") || "(none)"
      : "(new zone)";
    const now = z.bands.map(([k, r]) => `≤${k}kg ৳${r}`).join(", ");
    console.log(`${z.name.padEnd(22)} ${was}\n${"".padEnd(22)} → ${now}`);
    if (!APPLY) continue;

    // Bands are replaced rather than matched, exactly as the settings form
    // does it: nothing points at a band, so there is no id worth keeping.
    if (existing) {
      await prisma.$transaction(async (tx) => {
        await tx.courierRateBand.deleteMany({ where: { zoneId: existing.id } });
        await tx.courierZone.update({ where: { id: existing.id }, data: { rate: z.rate } });
        await tx.courierRateBand.createMany({
          data: z.bands.map(([uptoKg, rate]) => ({
            workspaceId: ws.id,
            zoneId: existing.id,
            uptoKg,
            rate,
          })),
        });
      });
    } else {
      await prisma.courierZone.create({
        data: {
          workspaceId: ws.id,
          courierId: courier.id,
          name: z.name,
          rate: z.rate,
          sortOrder: courier.zones.length,
          bands: {
            create: z.bands.map(([uptoKg, rate]) => ({ workspaceId: ws.id, uptoKg, rate })),
          },
        },
      });
    }
  }

  const order = await prisma.order.findFirst({
    where: { workspaceId: ws.id, courierTrackingId: REWEIGH.tracking },
    select: { id: true, weightKg: true, deliveryCost: true, customer: { select: { name: true } } },
  });
  if (order && Number(order.weightKg) === REWEIGH.from) {
    console.log(
      `\n${REWEIGH.tracking} ${order.customer?.name}: weight ${order.weightKg} → ${REWEIGH.to}` +
        ` (charged ৳${order.deliveryCost}, which only the new first step explains)`,
    );
    if (APPLY) {
      await prisma.order.update({ where: { id: order.id }, data: { weightKg: REWEIGH.to } });
    }
  }

  console.log(APPLY ? "\nDone." : "\nDry run — nothing written. Re-run with --apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
