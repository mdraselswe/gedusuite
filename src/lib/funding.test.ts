import { describe, expect, it } from "vitest";
import {
  creditedPartnerId,
  fundingNeedsPartner,
  fundingSourceOf,
  fundingSpendsTreasury,
  resolveFunding,
  type FundingSource,
} from "@/lib/funding";

const P = "partner-1";

describe("resolveFunding", () => {
  it("puts a partner-funded row on the partner and nowhere else", () => {
    expect(resolveFunding("PARTNER", P)).toEqual({
      paidByPartnerId: P,
      paidFromTreasury: false,
      onCredit: false,
    });
  });

  it("puts a treasury-funded row on the treasury and names nobody", () => {
    expect(resolveFunding("TREASURY", P)).toEqual({
      paidByPartnerId: null,
      paidFromTreasury: true,
      onCredit: false,
    });
  });

  it("sets both columns for a reimbursement", () => {
    expect(resolveFunding("REIMBURSED", P)).toEqual({
      paidByPartnerId: P,
      paidFromTreasury: true,
      onCredit: false,
    });
  });

  it("owes a supplier rather than spending anything on credit", () => {
    expect(resolveFunding("CREDIT", P)).toEqual({
      paidByPartnerId: null,
      paidFromTreasury: false,
      onCredit: true,
    });
  });

  it("drops a partner id left over from a previous choice", () => {
    // The forms keep the picker mounted while the radio changes, so a stale id
    // is the normal state, not an odd one.
    for (const source of ["NONE", "TREASURY", "CREDIT"] as const) {
      expect(resolveFunding(source, P).paidByPartnerId).toBeNull();
    }
  });
});

describe("creditedPartnerId", () => {
  it("credits the partner who really funded it", () => {
    expect(creditedPartnerId(resolveFunding("PARTNER", P))).toBe(P);
  });

  /**
   * The whole point of the new state. The credit cancels the expense that the
   * same row puts on the partner; a reimbursed row is not their expense, so a
   * credit would be capital they never left in.
   */
  it("credits nobody for a reimbursement, even though the row names a partner", () => {
    const flags = resolveFunding("REIMBURSED", P);
    expect(flags.paidByPartnerId).toBe(P);
    expect(creditedPartnerId(flags)).toBeNull();
  });

  it("credits nobody when the treasury paid", () => {
    expect(creditedPartnerId(resolveFunding("TREASURY", P))).toBeNull();
  });
});

describe("fundingSourceOf", () => {
  it("reads back every choice it can write", () => {
    const sources: FundingSource[] = ["NONE", "PARTNER", "TREASURY", "CREDIT", "REIMBURSED"];
    for (const source of sources) {
      expect(fundingSourceOf(resolveFunding(source, P))).toBe(source);
    }
  });

  /**
   * Every row written before REIMBURSED existed carries at most one of the two
   * columns, so none of them may start reading as a reimbursement.
   */
  it("leaves rows written before this existed reading exactly as they did", () => {
    expect(fundingSourceOf({ paidByPartnerId: P, paidFromTreasury: false, onCredit: false })).toBe("PARTNER");
    expect(fundingSourceOf({ paidByPartnerId: null, paidFromTreasury: true, onCredit: false })).toBe("TREASURY");
    expect(fundingSourceOf({ paidByPartnerId: null, paidFromTreasury: false, onCredit: true })).toBe("CREDIT");
    expect(fundingSourceOf({ paidByPartnerId: null, paidFromTreasury: false, onCredit: false })).toBe("NONE");
  });

  it("copes with a row that only selected some of the columns", () => {
    expect(fundingSourceOf({})).toBe("NONE");
    expect(fundingSourceOf({ paidByPartnerId: P })).toBe("PARTNER");
  });

  it("reads a row carrying both columns as a reimbursement, not partner-funded", () => {
    expect(fundingSourceOf({ paidByPartnerId: P, paidFromTreasury: true })).toBe("REIMBURSED");
  });
});

describe("which choices need what", () => {
  it("asks for a partner only where one is stored", () => {
    expect(fundingNeedsPartner("PARTNER")).toBe(true);
    expect(fundingNeedsPartner("REIMBURSED")).toBe(true);
    expect(fundingNeedsPartner("TREASURY")).toBe(false);
    expect(fundingNeedsPartner("NONE")).toBe(false);
    expect(fundingNeedsPartner("CREDIT")).toBe(false);
  });

  it("checks the treasury balance for anything that takes money out of it", () => {
    expect(fundingSpendsTreasury("TREASURY")).toBe(true);
    expect(fundingSpendsTreasury("REIMBURSED")).toBe(true);
    expect(fundingSpendsTreasury("PARTNER")).toBe(false);
    expect(fundingSpendsTreasury("CREDIT")).toBe(false);
    expect(fundingSpendsTreasury("NONE")).toBe(false);
  });
});
