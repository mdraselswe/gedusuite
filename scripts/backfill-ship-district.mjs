/**
 * Fill in `shipDistrict` from the district the customer actually picked.
 *
 * The column is tagged at booking time by matching English district names in
 * the free-text address, which is the only thing available for an order typed
 * in by hand — and it leaves most website orders blank, because a Dhaka
 * customer writes "Khilgoan, Mirpur 14" and never the word "Dhaka". 60 of 85
 * orders carry no district, so a per-district report is mostly one big
 * "(untagged)" bucket.
 *
 * WooCommerce already knows the answer exactly: the checkout's district select
 * writes an ISO 3166-2:BD code (BD-01..BD-64) into billing/shipping `state`,
 * and the whole webhook body is kept on OrderLead.rawPayload. So for every
 * order that came from the website the district is already in this database —
 * just not in the column that reports read.
 *
 * Only fills blanks. A district tagged at booking was tagged against the
 * address the parcel was actually sent to, and that is the better answer where
 * the two disagree — this never overwrites one.
 *
 * Orders entered by hand (referral, phone, Facebook) have no lead and stay
 * blank; there is nothing in the database to derive them from.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/backfill-ship-district.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/backfill-ship-district.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

// ISO 3166-2:BD -> the spellings in src/lib/bd-locations.ts, so a backfilled
// value is indistinguishable from one detectDistrict produced.
const ISO_BD = {
  "BD-01": "Bandarban", "BD-02": "Barguna", "BD-03": "Bogura", "BD-04": "Brahmanbaria",
  "BD-05": "Bagerhat", "BD-06": "Barishal", "BD-07": "Bhola", "BD-08": "Cumilla",
  "BD-09": "Chandpur", "BD-10": "Chattogram", "BD-11": "Cox's Bazar", "BD-12": "Chuadanga",
  "BD-13": "Dhaka", "BD-14": "Dinajpur", "BD-15": "Faridpur", "BD-16": "Feni",
  "BD-17": "Gopalganj", "BD-18": "Gazipur", "BD-19": "Gaibandha", "BD-20": "Habiganj",
  "BD-21": "Jamalpur", "BD-22": "Jashore", "BD-23": "Jhenaidah", "BD-24": "Joypurhat",
  "BD-25": "Jhalakathi", "BD-26": "Kishoreganj", "BD-27": "Khulna", "BD-28": "Kurigram",
  "BD-29": "Khagrachhari", "BD-30": "Kushtia", "BD-31": "Lakshmipur", "BD-32": "Lalmonirhat",
  "BD-33": "Manikganj", "BD-34": "Mymensingh", "BD-35": "Munshiganj", "BD-36": "Madaripur",
  "BD-37": "Magura", "BD-38": "Moulvibazar", "BD-39": "Meherpur", "BD-40": "Narayanganj",
  "BD-41": "Netrakona", "BD-42": "Narsingdi", "BD-43": "Narail", "BD-44": "Natore",
  "BD-45": "Chapainawabganj", "BD-46": "Nilphamari", "BD-47": "Noakhali", "BD-48": "Naogaon",
  "BD-49": "Pabna", "BD-50": "Pirojpur", "BD-51": "Patuakhali", "BD-52": "Panchagarh",
  "BD-53": "Rajbari", "BD-54": "Rajshahi", "BD-55": "Rangpur", "BD-56": "Rangamati",
  "BD-57": "Sherpur", "BD-58": "Satkhira", "BD-59": "Sirajganj", "BD-60": "Sylhet",
  "BD-61": "Sunamganj", "BD-62": "Shariatpur", "BD-63": "Tangail", "BD-64": "Thakurgaon",
};

const blanks = await prisma.order.findMany({
  where: { shipDistrict: null },
  select: { id: true, orderNo: true, date: true, status: true, source: true },
  orderBy: { date: "asc" },
});
const leads = await prisma.orderLead.findMany({
  where: { orderId: { in: blanks.map((o) => o.id) } },
  select: { orderId: true, rawPayload: true },
});
const payloadFor = new Map(leads.map((l) => [l.orderId, l.rawPayload]));

const plan = [];
const skipped = { noLead: 0, noState: 0, unknownCode: 0 };
for (const o of blanks) {
  const p = payloadFor.get(o.id);
  if (!p) { skipped.noLead++; continue; }
  const code = String(p?.shipping?.state || p?.billing?.state || "").trim().toUpperCase();
  if (!code) { skipped.noState++; continue; }
  const name = ISO_BD[code];
  // A code outside the list is worth seeing rather than swallowing — it would
  // mean the checkout started writing something other than an ISO district.
  if (!name) { skipped.unknownCode++; console.warn(`  ! order #${o.orderNo}: unknown state "${code}"`); continue; }
  plan.push({ ...o, code, name });
}

console.log(`${blanks.length} orders with no district; ${plan.length} can be filled from WooCommerce.`);
console.log(`skipped: ${skipped.noLead} not from the website, ${skipped.noState} no state in payload, ${skipped.unknownCode} unknown code\n`);
for (const r of plan) {
  console.log(`  #${String(r.orderNo).padStart(3)}  ${r.date.toISOString().slice(0, 10)}  ${r.status.padEnd(10)} -> ${r.name} (${r.code})`);
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
} else {
  for (const r of plan) {
    await prisma.order.update({ where: { id: r.id }, data: { shipDistrict: r.name } });
  }
  console.log(`\nWrote ${plan.length} districts.`);
}
await prisma.$disconnect();
