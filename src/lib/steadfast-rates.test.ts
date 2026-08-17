import { describe, it, expect } from "vitest";
import { quoteCourier, type CourierRules, type WeightBand } from "@/lib/courier";

/**
 * Steadfast's own price calculator, against this app's model of it.
 *
 * The rates a workspace charges live in the database, not here — this is not
 * a config file. What it pins is that the model can express a real courier's
 * price list at all: a handful of weight bands, then a flat rate per started
 * kilo above the last one. That shape was arrived at from parcels read off a
 * phone one at a time, and got it wrong twice — a 0.7kg Dhaka parcel quoted
 * at 85 when it costs 75, and a 0.2kg one at 55 when it costs 65. Both were
 * only found because a balance disagreed weeks later.
 *
 * The figures below are one shop's negotiated card, read straight off
 * Steadfast's calculator across four services. They are here as a fixture with
 * real edges in it — a 150g first step in one column and none in another, a
 * second step at 500g in two columns and at a kilo in the others — not as
 * anybody's live pricing.
 */

const RULES: CourierRules = {
  baseWeightKg: 0.5,
  extraKgRate: 20,
  codFeePercent: 1,
  codFeeBase: "NET",
  returnChargeType: "NONE",
  returnChargeValue: 0,
};

/**
 * Only the steps below a kilo need bands. Above that the card rises by exactly
 * the per-kilo rate, which is what `quoteCourier` already does past the last
 * band — so thirteen rows of price list come out of two or three rows of data.
 */
const ZONES: Record<string, { zoneRate: number; bands: WeightBand[] }> = {
  "Dhaka City": {
    zoneRate: 65,
    bands: [
      { uptoKg: 0.15, rate: 55 },
      { uptoKg: 0.5, rate: 65 },
      { uptoKg: 1, rate: 75 },
    ],
  },
  "Dhaka City Express": { zoneRate: 105, bands: [{ uptoKg: 1, rate: 105 }] },
  "Dhaka Sub-urban": { zoneRate: 105, bands: [{ uptoKg: 1, rate: 105 }] },
  "Outside Dhaka": {
    zoneRate: 115,
    bands: [
      { uptoKg: 0.5, rate: 115 },
      { uptoKg: 1, rate: 135 },
    ],
  },
};

/** Weight in, price out — every row the calculator gives for each service. */
const CARD: Record<string, [weightKg: number, charge: number][]> = {
  "Dhaka City": [
    [0.1, 55], [0.16, 65], [0.51, 75], [1.1, 95], [2.1, 115], [3.1, 135],
    [4.1, 155], [5.1, 175], [6.1, 195], [7.1, 215], [8.1, 235], [9.1, 255],
    [10.1, 275],
  ],
  "Dhaka City Express": [
    [0.1, 105], [1.1, 125], [2.1, 145], [3.1, 165], [4.1, 185], [5.1, 205],
    [6.1, 225], [7.1, 245], [8.1, 265], [9.1, 285], [10.1, 305],
  ],
  "Dhaka Sub-urban": [
    [0.1, 105], [1.1, 125], [2.1, 145], [3.1, 165], [4.1, 185], [5.1, 205],
    [6.1, 225], [7.1, 245], [8.1, 265], [9.1, 285], [10.1, 305],
  ],
  "Outside Dhaka": [
    [0.1, 115], [0.6, 135], [1.1, 155], [2.1, 175], [3.1, 195], [4.1, 215],
    [5.1, 235], [6.1, 255], [7.1, 275], [8.1, 295], [9.1, 315], [10.1, 335],
  ],
};

const charge = (zone: string, weightKg: number | null) =>
  quoteCourier(RULES, { ...ZONES[zone], weightKg, codAmount: 0 }).deliveryCharge;

describe("a real courier price card, expressed as bands", () => {
  for (const [zone, rows] of Object.entries(CARD)) {
    it(`matches every step of ${zone}`, () => {
      for (const [weightKg, want] of rows) {
        expect(`${weightKg}kg → ${charge(zone, weightKg)}`).toBe(`${weightKg}kg → ${want}`);
      }
    });
  }

  /**
   * The parcels this shop was actually billed for, with the weight Steadfast's
   * own app recorded. The card says what it should cost; these are what it did.
   */
  it("matches what the courier actually billed, parcel by parcel", () => {
    const billed: [zone: string, weightKg: number, charge: number][] = [
      ["Dhaka City", 0.15, 55],
      ["Dhaka City", 0.3, 65],
      ["Dhaka City", 0.4, 65],
      ["Dhaka City", 0.5, 65],
      ["Dhaka City", 0.7, 75],
      ["Dhaka Sub-urban", 0.39, 105],
      ["Outside Dhaka", 0.37, 115],
      ["Outside Dhaka", 0.41, 115],
      ["Outside Dhaka", 0.5, 115],
    ];
    for (const [zone, weightKg, want] of billed) {
      expect(`${zone} ${weightKg}kg → ${charge(zone, weightKg)}`).toBe(
        `${zone} ${weightKg}kg → ${want}`,
      );
    }
  });

  /**
   * A parcel nobody weighed takes the top band, which on a card this long is a
   * long way from typical: 75 where almost every Dhaka parcel costs 65, and
   * 135 where almost every one outside costs 115. Deliberate — a cost quoted
   * too low makes an order look better than it was, and that is the error that
   * never gets investigated — but it is a reason to weigh the products rather
   * than a substitute for it.
   */
  it("quotes the top band when nothing has been weighed", () => {
    expect(charge("Dhaka City", null)).toBe(75);
    expect(charge("Dhaka Sub-urban", null)).toBe(105);
    expect(charge("Outside Dhaka", null)).toBe(135);
  });
});
