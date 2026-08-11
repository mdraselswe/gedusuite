/**
 * The 64 district names, used to sanity-check a courier address.
 *
 * This list is never shown as a dropdown, never sent anywhere, and never
 * matched against anything on the courier's side. Steadfast's API has no
 * district field at all — its own WooCommerce plugin concatenates the city
 * into `recipient_address` and posts six fields in total — so the address is
 * one line of free text and the only question worth asking about it is whether
 * it looks complete before somebody presses Book.
 *
 * That is the whole job here: `mentionsDistrict` answers "does this address
 * name a district?", and a "no" raises a warning on the dialog. Deliberately a
 * warning and not a block — a perfectly good address can say "ঢাকা" in Bangla
 * or "Ctg" in shorthand, and refusing to ship it would be this file deciding
 * something it is not equipped to decide.
 *
 * An earlier draft carried all 494 upazilas as well, to fill district and
 * thana dropdowns. That was dropped: the picked values only ever became text
 * on the address line, so the dropdowns were scaffolding around a field the
 * person is already reading and can already edit. What is left is the check.
 *
 * Source: nuhil/bangladesh-geocode, in the spellings used today — Cumilla,
 * Chattogram, Jashore, Bogura, Barishal.
 */

export const DISTRICTS: readonly string[] = [
  "Bagerhat",
  "Bandarban",
  "Barguna",
  "Barishal",
  "Bhola",
  "Bogura",
  "Brahmanbaria",
  "Chandpur",
  "Chapainawabganj",
  "Chattogram",
  "Chuadanga",
  "Cox's Bazar",
  "Cumilla",
  "Dhaka",
  "Dinajpur",
  "Faridpur",
  "Feni",
  "Gaibandha",
  "Gazipur",
  "Gopalganj",
  "Habiganj",
  "Jamalpur",
  "Jashore",
  "Jhalakathi",
  "Jhenaidah",
  "Joypurhat",
  "Khagrachhari",
  "Khulna",
  "Kishoreganj",
  "Kurigram",
  "Kushtia",
  "Lakshmipur",
  "Lalmonirhat",
  "Madaripur",
  "Magura",
  "Manikganj",
  "Meherpur",
  "Moulvibazar",
  "Munshiganj",
  "Mymensingh",
  "Naogaon",
  "Narail",
  "Narayanganj",
  "Narsingdi",
  "Natore",
  "Netrakona",
  "Nilphamari",
  "Noakhali",
  "Pabna",
  "Panchagarh",
  "Patuakhali",
  "Pirojpur",
  "Rajbari",
  "Rajshahi",
  "Rangamati",
  "Rangpur",
  "Satkhira",
  "Shariatpur",
  "Sherpur",
  "Sirajganj",
  "Sunamganj",
  "Sylhet",
  "Tangail",
  "Thakurgaon",
];

/**
 * Spellings that were official until recently and are still what half of the
 * country types. Recognising them is the point — an address saying "Comilla"
 * is a complete address, and warning about it would train people to ignore the
 * warning.
 */
const ALSO_ACCEPTED: Record<string, string> = {
  Comilla: "Cumilla",
  Chittagong: "Chattogram",
  Ctg: "Chattogram",
  Jessore: "Jashore",
  Bogra: "Bogura",
  Barisal: "Barishal",
  Netrokona: "Netrakona",
  Jhalokati: "Jhalakathi",
  Nawabganj: "Chapainawabganj",
  "Chapai Nawabganj": "Chapainawabganj",
  Coxsbazar: "Cox's Bazar",
  "Coxs Bazar": "Cox's Bazar",
  Maulvibazar: "Moulvibazar",
  Moulavibazar: "Moulvibazar",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which district this address appears to name, or null.
 *
 * Matched on a word boundary so "Dhakadakshin" — which is in Sylhet — does not
 * read as Dhaka. Longest name first, so "Chapainawabganj" wins over the
 * "Nawabganj" inside it.
 *
 * Best-effort by construction, and treated as such everywhere it is used: it
 * raises a warning on the booking dialog and tags the order for reports. It
 * never changes what is sent, and never decides whether a parcel goes.
 */
export function detectDistrict(address: string | null | undefined): string | null {
  const text = (address ?? "").trim();
  if (!text) return null;

  const candidates: [string, string][] = [
    ...DISTRICTS.map((d) => [d, d] as [string, string]),
    ...Object.entries(ALSO_ACCEPTED),
  ];
  candidates.sort((a, b) => b[0].length - a[0].length);

  for (const [written, canonical] of candidates) {
    if (new RegExp(`(^|[^\\p{L}])${escapeRegExp(written)}([^\\p{L}]|$)`, "iu").test(text)) {
      return canonical;
    }
  }
  return null;
}

export function mentionsDistrict(address: string | null | undefined): boolean {
  return detectDistrict(address) !== null;
}
