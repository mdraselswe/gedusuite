import { describe, expect, it } from "vitest";
import { SPEND_CATEGORIES, spendCategoryLabel, spendFundingLabel } from "@/lib/spending";

/**
 * The rule that decides whether a treasury OUT row is its own spending event
 * or a mirror of one already counted. Mirrored here because the real query
 * expresses it as a Prisma `where` — this is the same predicate, made testable.
 *
 * It matters more than it looks. This shop's ledger holds exactly one OUT row
 * and it carries a purchaseId: built from the treasury, this page would have
 * double-counted that purchase and missed every partner-funded one, which is
 * almost all of them.
 */
function isOwnEvent(e: {
  partnerTxnId?: string | null;
  orderId?: string | null;
  purchaseId?: string | null;
  internalPurchaseId?: string | null;
  distributionId?: string | null;
  boostSpendId?: string | null;
}): boolean {
  return (
    !e.partnerTxnId &&
    !e.orderId &&
    !e.purchaseId &&
    !e.internalPurchaseId &&
    !e.distributionId &&
    !e.boostSpendId
  );
}

/** Which of the four funding states a purchase row is in. */
function fundingOf(p: {
  paidFromTreasury: boolean;
  paidByPartnerId: string | null;
  onCredit: boolean;
}) {
  if (p.paidFromTreasury) return "TREASURY";
  if (p.paidByPartnerId) return "PARTNER";
  if (p.onCredit) return "CREDIT";
  return "UNRECORDED";
}

describe("treasury rows that mirror something else", () => {
  it("excludes a treasury OUT written by a purchase", () => {
    // Counting this would report the purchase twice — once from Purchase and
    // once from the entry that purchase created.
    expect(isOwnEvent({ purchaseId: "p1" })).toBe(false);
  });

  it("excludes every other derived link", () => {
    for (const key of [
      "partnerTxnId",
      "orderId",
      "internalPurchaseId",
      "distributionId",
      "boostSpendId",
    ]) {
      expect(isOwnEvent({ [key]: "x" })).toBe(false);
    }
  });

  it("keeps a hand-entered one", () => {
    // Rent typed straight into the ledger has no source row anywhere else, so
    // excluding it would lose the spend entirely.
    expect(isOwnEvent({})).toBe(true);
  });
});

describe("funding state of a purchase", () => {
  const base = { paidFromTreasury: false, paidByPartnerId: null, onCredit: false };

  it("reads the four states apart", () => {
    expect(fundingOf({ ...base, paidFromTreasury: true })).toBe("TREASURY");
    expect(fundingOf({ ...base, paidByPartnerId: "abc" })).toBe("PARTNER");
    expect(fundingOf({ ...base, onCredit: true })).toBe("CREDIT");
    expect(fundingOf(base)).toBe("UNRECORDED");
  });

  it("is why the treasury alone can't answer this page", () => {
    // Three of the four states write nothing to the treasury at all.
    const nonTreasury = [
      { ...base, paidByPartnerId: "abc" },
      { ...base, onCredit: true },
      base,
    ];
    for (const p of nonTreasury) expect(fundingOf(p)).not.toBe("TREASURY");
  });
});

describe("labels", () => {
  it("names every category and funding state", () => {
    for (const c of SPEND_CATEGORIES) expect(spendCategoryLabel[c]).toBeTruthy();
    for (const f of ["TREASURY", "PARTNER", "CREDIT", "UNRECORDED"] as const) {
      expect(spendFundingLabel[f]).toBeTruthy();
    }
  });
});
