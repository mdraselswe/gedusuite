/**
 * What a courier actually charges for one parcel.
 *
 * Worked out from the courier's own rules rather than typed in, because the
 * part everyone forgets is the percentage fee. Steadfast quotes ৳115 to send
 * a parcel outside Dhaka and that is the number that gets written down — but
 * on a ৳960 COD it also keeps 1% of what it hands over, so the real cost is
 * ৳123.45. Charging the customer ৳120 looked like ৳5 of margin and was in
 * fact a ৳3.45 loss, on every single order.
 *
 * Deliberately pure: the order form previews with it, the server stores what
 * it returns, and the reconciliation page re-runs it against the courier's
 * own statement. One formula, three callers — the alternative is three
 * formulas that agree until they don't.
 */

import { round2 } from "@/lib/money";

export type CodFeeBase = "GROSS" | "NET";
export type ReturnChargeType = "NONE" | "FLAT" | "PERCENT_OF_DELIVERY";

/** A courier's pricing, as stored on the Courier row. */
export type CourierRules = {
  baseWeightKg: number;
  extraKgRate: number;
  codFeePercent: number;
  codFeeBase: CodFeeBase;
  returnChargeType: ReturnChargeType;
  returnChargeValue: number;
};

/** One step of a zone's price list: at or below `uptoKg`, it costs `rate`. */
export type WeightBand = { uptoKg: number; rate: number };

export type CourierQuoteInput = {
  /** The zone's flat rate up to baseWeightKg — used when it has no bands. */
  zoneRate: number;
  /** The zone's weight steps, in any order. Empty for a flat-rate zone. */
  bands?: WeightBand[];
  /** Parcel weight. Unknown (null) is treated as within the base weight. */
  weightKg?: number | null;
  /** What the customer pays on delivery — goods plus delivery charge. */
  codAmount: number;
};

/**
 * Which step of the price list a parcel falls in, and how much weight that
 * step covers.
 *
 * An unknown weight takes the HEAVIEST band, never the cheapest. Quoting a
 * parcel nobody has weighed at the light rate would under-charge it by
 * default, and a delivery cost that is too low is the one that goes unnoticed
 * — it makes an order look more profitable than it was, which is not a thing
 * anybody goes looking for.
 *
 * Heavier than every band is the last band plus the per-kilo charge above it,
 * measured from that band's limit rather than from `baseWeightKg`: with bands,
 * the top band IS the included weight.
 */
export function zoneRateFor(
  input: Pick<CourierQuoteInput, "zoneRate" | "bands" | "weightKg">,
  baseWeightKg: number,
): { rate: number; includedKg: number } {
  const bands = [...(input.bands ?? [])].sort((a, b) => a.uptoKg - b.uptoKg);
  if (bands.length === 0) return { rate: round2(input.zoneRate), includedKg: baseWeightKg };

  const heaviest = bands[bands.length - 1];
  if (input.weightKg == null) return { rate: round2(heaviest.rate), includedKg: heaviest.uptoKg };

  const match = bands.find((b) => input.weightKg! <= b.uptoKg) ?? heaviest;
  return { rate: round2(match.rate), includedKg: match.uptoKg };
}

export type CourierQuote = {
  zoneRate: number;
  weightCharge: number;
  /** zoneRate + weightCharge — what the courier calls "delivery charge". */
  deliveryCharge: number;
  codFee: number;
  /** Everything the courier keeps. */
  total: number;
};

/**
 * Weight above the included allowance, charged per STARTED kilo.
 *
 * 1.2 kg on a 1 kg allowance is one extra kilo, not 0.2 of one — couriers
 * round up, and rounding down here would under-quote every heavy parcel.
 */
function weightCharge(
  rules: CourierRules,
  weightKg: number | null | undefined,
  includedKg: number,
): number {
  if (weightKg == null) return 0;
  const over = weightKg - includedKg;
  if (over <= 0) return 0;
  return round2(Math.ceil(over) * rules.extraKgRate);
}

/**
 * The percentage the courier keeps, on a delivery charge that is already
 * known.
 *
 * GROSS takes it off the whole COD; NET off what's left once the courier's own
 * delivery charge is out. On a 960 parcel at 1% that is 9.60 against 8.45 —
 * the reason this is a setting and not a constant.
 *
 * Separate from `quoteCourier` because the charge is not always the one the
 * rate table would quote. A parcel whose real bill has been read off the
 * courier's app and typed in is the authority on itself, and the fee has to
 * follow that number rather than the estimate it replaced — otherwise a cost
 * corrected from 135 to 155 keeps a fee worked out from the 135.
 */
export function codFeeOn(
  rules: Pick<CourierRules, "codFeePercent" | "codFeeBase">,
  codAmount: number,
  deliveryCharge: number,
): number {
  const base =
    rules.codFeeBase === "GROSS" ? codAmount : Math.max(0, codAmount - deliveryCharge);
  return round2((base * rules.codFeePercent) / 100);
}

export function quoteCourier(rules: CourierRules, input: CourierQuoteInput): CourierQuote {
  const { rate, includedKg } = zoneRateFor(input, rules.baseWeightKg);
  const extra = weightCharge(rules, input.weightKg, includedKg);
  const deliveryCharge = round2(rate + extra);
  const codFee = codFeeOn(rules, input.codAmount, deliveryCharge);

  return {
    // The band's rate when the zone has bands, not the zone's flat one — this
    // is what the "delivery charge" on screen breaks down into.
    zoneRate: rate,
    weightCharge: extra,
    deliveryCharge,
    codFee,
    total: round2(deliveryCharge + codFee),
  };
}

/**
 * What a parcel costs when it comes back undelivered. No COD was collected,
 * so there is no percentage fee — only whatever the courier charges for the
 * failed trip.
 */
export function quoteReturnCharge(
  rules: CourierRules,
  input: { zoneRate: number; bands?: WeightBand[]; weightKg?: number | null },
): number {
  const { rate, includedKg } = zoneRateFor(input, rules.baseWeightKg);
  const delivery = round2(rate + weightCharge(rules, input.weightKg, includedKg));
  switch (rules.returnChargeType) {
    case "FLAT":
      return round2(rules.returnChargeValue);
    case "PERCENT_OF_DELIVERY":
      return round2((delivery * rules.returnChargeValue) / 100);
    default:
      return 0;
  }
}

/**
 * What the courier should be holding for a set of settled parcels: what it
 * collected, less what it keeps.
 *
 * The percentage fee is worked out across the whole set and rounded to a whole
 * taka, which is not how the same fee is stored on each order — and both are
 * right, for different questions. An order's own fee is its share of a cost,
 * and profit needs it per order. A balance is what one account owes another,
 * and the courier computes that on the payout as a whole.
 *
 * Read off real Steadfast payouts rather than assumed: 18,199 collected less
 * 2,075 of delivery bills is 16,124, and it charged 161 — 161.24. The next one,
 * 18,760 less 2,410, is 16,350, and it charged 164 — 163.50 rounded UP. That
 * second payout is what settled it: floor gives 163 there, so this is rounded
 * to nearest, not floored, and the balance page had been predicting a taka more
 * than Steadfast was ever going to pay.
 *
 * Summing the per-order figures instead gives 161.24 and 166.25: out by a
 * quarter taka on the first and by 2.25 on the second, where a parcel that
 * collected nothing still drags the fee base down for the whole set with its
 * delivery bill, but is floored at zero on its own row. That residue belongs to
 * the payout, not to any one order, and the payout import records it as its own
 * treasury line rather than smearing it across parcels whose own quote — taken
 * alone, at booking time — was right.
 */
export function expectedCourierBalance(
  parcels: { codAmount: number; deliveryCost: number }[],
  rules?: Pick<CourierRules, "codFeePercent" | "codFeeBase">,
): number {
  const collected = parcels.reduce((s, p) => s + p.codAmount, 0);
  const delivery = parcels.reduce((s, p) => s + p.deliveryCost, 0);
  const base = rules?.codFeeBase === "GROSS" ? collected : collected - delivery;
  const pct = rules?.codFeePercent ?? 0;
  // Rounded, and never below nothing: a set whose delivery bills outrun what
  // it collected owes a fee on nothing, not a negative one.
  const codFee = Math.round(Math.max(0, base) * (pct / 100));
  return round2(collected - delivery - codFee);
}

/**
 * The delivery charge at which a parcel stops losing money.
 *
 * Not simply the courier's delivery charge: raising what the customer pays
 * also raises the COD the courier takes its percentage of, so the break-even
 * chases itself. Solved rather than guessed —
 *
 *   charge = deliveryCharge + pct × (goods + charge)      [GROSS]
 *   charge = deliveryCharge + pct × (goods + charge − deliveryCharge)  [NET]
 *
 * Returns null when the percentage is 100% or more and no charge can ever
 * cover it.
 */
export function breakEvenDeliveryCharge(
  rules: CourierRules,
  input: { zoneRate: number; bands?: WeightBand[]; weightKg?: number | null; goodsAmount: number },
): number | null {
  const { rate, includedKg } = zoneRateFor(input, rules.baseWeightKg);
  const delivery = round2(rate + weightCharge(rules, input.weightKg, includedKg));
  const pct = rules.codFeePercent / 100;
  if (pct >= 1) return null;
  const base = rules.codFeeBase === "GROSS" ? input.goodsAmount : input.goodsAmount - delivery;
  return round2((delivery + pct * base) / (1 - pct));
}
