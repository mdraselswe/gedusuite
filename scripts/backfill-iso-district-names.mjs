/**
 * Turn the ISO codes stuck in written addresses into district names.
 *
 * The website's checkout stores the district the customer picked as an ISO
 * 3166-2:BD code, and WooCommerce hands it over as billing/shipping `state`.
 * lib/woo.ts appended it to the address as it came, so a lead read "…, Demra,
 * BD-13" — the district is there, spelled as something nobody can read. From
 * the lead it was copied onto the customer record and onto the address the
 * courier prints, so the same code is now in three tables.
 *
 * lib/woo.ts writes the name for every order that arrives from now on. This
 * fixes the ones already stored, in place: only the BD-xx token changes, the
 * rest of the line is left exactly as the customer wrote it.
 *
 * Dry run by default — prints every row it would touch and writes nothing.
 *
 *   node -r dotenv/config scripts/backfill-iso-district-names.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/backfill-iso-district-names.mjs --apply dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/backfill-iso-district-names.mjs --apply --skip-orders dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
// Order.shipAddress is a record of how a parcel was addressed, so it gets its
// own switch: replacing a code with its own name changes nothing about where
// anything went, but that is a judgement about history and worth leaving to
// whoever runs this.
const SKIP_ORDERS = process.argv.includes("--skip-orders");
const prisma = new PrismaClient();

// ISO 3166-2:BD -> the spellings in src/lib/bd-locations.ts. Duplicated from
// there on purpose: this runs under plain node, which cannot import TypeScript.
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

const CODE = /\bBD-\d{2}\b/gi;

/**
 * The address with its codes named — or null when nothing would change.
 *
 * Only the BD-xx token is touched. Everything else — the customer's spacing,
 * their line breaks, the commas they did or didn't leave — is left byte for
 * byte as they typed it, because this script is correcting one field the
 * checkout wrote, not tidying anybody's handwriting.
 *
 * A code the table has never heard of is left alone rather than deleted: it is
 * still whatever the customer's checkout meant by it, and this is not the place
 * to decide it was noise.
 */
function named(address) {
  if (!address || !CODE.test(address)) return null;
  CODE.lastIndex = 0;

  const next = dropDuplicateTail(address.replace(CODE, (m) => ISO_BD[m.toUpperCase()] ?? m));
  return next !== address ? next : null;
}

/**
 * Drop a trailing ", Cumilla" that now repeats the segment before it.
 *
 * The naming creates that duplicate whenever the town somebody typed is the
 * district itself. Once only, and only at the end: a repetition that was
 * already in the address is theirs, and not this script's to remove.
 */
function dropDuplicateTail(text) {
  const i = text.lastIndexOf(",");
  if (i === -1) return text;
  const last = text.slice(i + 1).trim();
  const rest = text.slice(0, i);
  const j = rest.lastIndexOf(",");
  const prev = (j === -1 ? rest : rest.slice(j + 1)).trim();
  return last && prev && last.toLowerCase() === prev.toLowerCase() ? rest : text;
}

async function sweep(label, rows, field, update) {
  const changes = rows
    .map((r) => ({ id: r.id, from: r[field], to: named(r[field]) }))
    .filter((c) => c.to !== null);

  console.log(`\n${label}: ${rows.length} row(s), ${changes.length} to rewrite`);
  for (const c of changes) {
    console.log(`  ${c.from}\n  -> ${c.to}`);
  }
  if (APPLY) {
    for (const c of changes) await update(c.id, c.to);
    console.log(`  written: ${changes.length}`);
  }
  return changes.length;
}

const leads = await prisma.orderLead.findMany({ select: { id: true, address: true } });
const customers = await prisma.customer.findMany({ select: { id: true, address: true } });
const orders = SKIP_ORDERS
  ? []
  : await prisma.order.findMany({ select: { id: true, shipAddress: true } });

let total = 0;
total += await sweep("OrderLead.address", leads, "address", (id, address) =>
  prisma.orderLead.update({ where: { id }, data: { address } }),
);
total += await sweep("Customer.address", customers, "address", (id, address) =>
  prisma.customer.update({ where: { id }, data: { address } }),
);
if (!SKIP_ORDERS) {
  total += await sweep("Order.shipAddress", orders, "shipAddress", (id, shipAddress) =>
    prisma.order.update({ where: { id }, data: { shipAddress } }),
  );
}

console.log(
  `\n${APPLY ? "Rewrote" : "Would rewrite"} ${total} row(s).` +
    (APPLY ? "" : " Re-run with --apply to write."),
);
await prisma.$disconnect();
