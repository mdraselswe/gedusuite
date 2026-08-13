/**
 * Run the courier payout import from the command line.
 *
 * The same work the "Import payouts" button does, for the first run — that one
 * needs a signed-in session, and the first import is the one somebody wants
 * done before they trust the button with the next.
 *
 * Deliberately narrower than the action: if a payout names an order whose cash
 * is not already banked, this stops rather than banking it. Banking an order
 * writes a treasury entry, an activity line and a flag, and that belongs to the
 * code path with a person's name attached to it, not to a script.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/import-courier-payouts.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/import-courier-payouts.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";
import { createDecipheriv, createHash } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const BASE = "https://portal.packzy.com/api/v1";
const prisma = new PrismaClient();
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const n = (v) => (v == null ? 0 : Number(v));

/** lib/crypto's format and key derivation, copied rather than imported: this
 *  file runs under plain node, and that one is TypeScript. */
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
  const courier = await prisma.courier.findFirst({
    where: { name: "Steadfast", apiKeyEnc: { not: null } },
  });
  if (!courier) throw new Error("no Steadfast courier with an API key");

  const headers = {
    "Api-Key": decrypt(courier.apiKeyEnc),
    "Secret-Key": decrypt(courier.apiSecretEnc),
    "Content-Type": "application/json",
  };
  const get = async (p) => {
    const res = await fetch(`${BASE}${p}`, { headers });
    return res.json();
  };

  const list = await get("/payments");
  const known = await prisma.courierPayout.findMany({
    where: { courierId: courier.id },
    select: { externalId: true },
  });
  const seen = new Set(known.map((k) => k.externalId));

  const pending = (list.payments ?? [])
    .filter((p) => !seen.has(p.payment_id))
    .sort((a, b) => (a.paid_at ?? "").localeCompare(b.paid_at ?? ""));

  console.log(APPLY ? "APPLYING\n" : "DRY RUN — nothing is written\n");
  console.log(`${list.payments?.length ?? 0} payout(s) at Steadfast, ${seen.size} already recorded, ${pending.length} to import\n`);

  for (const summary of pending) {
    const detail = (await get(`/payments/${summary.payment_id}`)).payment;
    const ids = detail.consignments.map((c) => String(c.consignment_id));
    const orders = await prisma.order.findMany({
      where: { workspaceId: courier.workspaceId, courierTrackingId: { in: ids } },
      include: { items: { include: { returns: true } }, customer: { select: { name: true } } },
    });
    const found = new Set(orders.map((o) => o.courierTrackingId));
    const unmatched = ids.filter((i) => !found.has(i));
    const unbanked = orders.filter((o) => !o.cashInTreasury);

    if (unbanked.length > 0) {
      console.log(
        `! ${summary.payment_id}: ${unbanked.length} order(s) are not banked yet ` +
          `(${unbanked.map((o) => o.customer?.name).join(", ")}). Use the Import payouts ` +
          `button instead — banking cash is not this script's job.`,
      );
      continue;
    }

    // Every matched order is banked, so what the treasury holds against this
    // payout is the sum of their entries.
    const entries = await prisma.treasuryEntry.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: { amount: true, type: true },
    });
    const ordersTotal = r2(
      entries.reduce((s, e) => s + (e.type === "OUT" ? -n(e.amount) : n(e.amount)), 0),
    );
    const difference = r2(n(detail.total) - ordersTotal);

    console.log(`${summary.payment_id}`);
    console.log(`  consignments      : ${ids.length}  matched: ${orders.length}  unmatched: ${unmatched.length ? unmatched.join(", ") : "none"}`);
    console.log(`  treasury holds    : ${ordersTotal}`);
    console.log(`  Steadfast paid    : ${n(detail.total)}`);
    console.log(`  difference entry  : ${difference > 0 ? "IN" : "OUT"} ${Math.abs(difference)}`);

    if (!APPLY) continue;

    const payout = await prisma.courierPayout.create({
      data: {
        workspaceId: courier.workspaceId,
        courierId: courier.id,
        externalId: detail.payment_id,
        amount: n(detail.amount),
        deliveryBills: n(detail.due_bills),
        charges: n(detail.charges),
        total: n(detail.total),
        method: detail.method ?? null,
        paidAt: detail.paid_at ? new Date(detail.paid_at.replace(" ", "T") + "Z") : null,
        consignmentIds: ids,
        ordersTotal,
      },
    });

    if (Math.abs(difference) >= 0.01) {
      await prisma.treasuryEntry.create({
        data: {
          workspaceId: courier.workspaceId,
          type: difference < 0 ? "OUT" : "IN",
          amount: Math.abs(difference),
          source: `${courier.name} payout difference`,
          note:
            `${courier.name} paid ৳${n(detail.total)} on ${detail.payment_id}; the ` +
            `${orders.length} order(s) in it come to ৳${ordersTotal}. The fee is charged on ` +
            `the payout as a whole and rounded, so the two never land on the same paisa.`,
          date: payout.paidAt ?? new Date(),
        },
      });
    }

    await prisma.activityLog.create({
      data: {
        workspaceId: courier.workspaceId,
        actorLabel: "Payout import",
        action: "CREATE",
        entity: "CourierPayout",
        entityId: payout.id,
        entityLabel: `${courier.name} · ${detail.payment_id}`,
        summary:
          `Payout imported — ৳${n(detail.total)} for ${orders.length} parcel(s)` +
          (Math.abs(difference) >= 0.01 ? `, ৳${Math.abs(difference)} difference recorded` : ""),
      },
    });
    console.log("  written.");
  }

  console.log(APPLY ? "\nDone." : "\nRe-run with --apply to write.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
