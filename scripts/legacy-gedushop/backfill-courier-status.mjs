/**
 * Fill in the courier's last word on parcels that are already finished.
 *
 * The scheduled sync only asks about parcels in flight — a settled order is
 * done, and re-asking about it every half hour would be calls spent on news
 * that cannot change. The cost of that is the parcels settled BEFORE the sync
 * existed: five of them still carry "in_review" from the only thing the webhook
 * ever sent, so a delivered order reads "Booked", and twenty-eight carry
 * nothing at all.
 *
 * One pass fixes them for good. Everything settled from here on is caught while
 * it is still moving.
 *
 * Deliberately narrow: this writes `courierStatus` and nothing else. The
 * order's own status was decided by a person looking at the parcel, and a
 * script is not the thing to overrule that.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/backfill-courier-status.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/backfill-courier-status.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";
import { createDecipheriv, createHash } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const BASE = "https://portal.packzy.com/api/v1";
const prisma = new PrismaClient();

function decrypt(payload) {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("BACKUP_ENCRYPTION_KEY or NEXTAUTH_SECRET must be set");
  const key = createHash("sha256").update(secret).digest();
  const [iv, tag, data] = payload.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

async function main() {
  const couriers = await prisma.courier.findMany({ where: { apiKeyEnc: { not: null } } });
  console.log(APPLY ? "APPLYING\n" : "DRY RUN — nothing is written\n");

  for (const courier of couriers) {
    const headers = {
      "Api-Key": decrypt(courier.apiKeyEnc),
      "Secret-Key": decrypt(courier.apiSecretEnc),
      "Content-Type": "application/json",
    };

    // Settled parcels whose courier line is missing or predates the sync.
    const orders = await prisma.order.findMany({
      where: {
        courierId: courier.id,
        courierTrackingId: { not: null },
        status: { in: ["DELIVERED", "CANCELLED"] },
        OR: [{ courierStatus: null }, { courierStatus: "in_review" }],
      },
      orderBy: { date: "asc" },
      select: {
        id: true,
        courierTrackingId: true,
        courierStatus: true,
        status: true,
        customer: { select: { name: true } },
      },
    });
    console.log(`${courier.name}: ${orders.length} settled parcel(s) with a stale courier line\n`);

    const counts = {};
    for (const o of orders) {
      const res = await fetch(`${BASE}/status_by_cid/${o.courierTrackingId}`, { headers });
      const body = await res.json().catch(() => null);
      const status = body?.delivery_status?.trim().toLowerCase();
      if (!status) {
        console.log(`  ! ${o.courierTrackingId} ${o.customer?.name ?? ""} — no status returned`);
        continue;
      }
      counts[status] = (counts[status] ?? 0) + 1;
      console.log(
        `  ${o.courierTrackingId}  ${String(o.customer?.name ?? "").slice(0, 22).padEnd(23)} ` +
          `${String(o.courierStatus ?? "(none)").padEnd(12)} -> ${status}`,
      );
      if (APPLY) {
        await prisma.order.update({
          where: { id: o.id },
          data: { courierStatus: status, courierStatusAt: new Date() },
        });
      }
    }
    console.log("\n  totals:", JSON.stringify(counts));
  }

  console.log(APPLY ? "\nDone." : "\nRe-run with --apply to write.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
