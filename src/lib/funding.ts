/**
 * Whose money paid for a purchase, an internal purchase or a day of ads.
 *
 * One rule, in one place, because it was in four: the two purchase forms each
 * had a `fundingSourceOf`, the spending page had a `fundingOf`, and each server
 * action worked the flags out again from the form field. They agreed, which is
 * the only reason nothing had gone wrong yet.
 *
 * Two database columns carry the answer — `paidByPartnerId` and
 * `paidFromTreasury` — plus `onCredit` where a supplier is willing to wait.
 * They used to be described as mutually exclusive, and that is what left a
 * common case with nowhere to go.
 *
 * ## The case with nowhere to go
 *
 * A partner puts the ad spend on their own card and the treasury pays them back
 * a few days later. Recorded as PARTNER, the ledger says the partner's capital
 * funded it, which stops being true the moment they are reimbursed. Recorded as
 * TREASURY, the arithmetic is right but the fact that they fronted it is gone.
 *
 * So the only way to say it was PARTNER plus a hand-written withdrawal — and
 * that quietly broke the books. A partner-funded row writes an automatic
 * INVESTMENT credit whose whole job is to cancel the expense; a withdrawal
 * cancels the credit and leaves the expense standing, so "remaining" fell by
 * the full amount for a transaction that cost the partner nothing on net. Two
 * reimbursements in the live workspace had taken one partner to −3,355.70.
 *
 * REIMBURSED sets both columns and means what neither did on its own: the money
 * left the treasury, and this is who handed it over first. `paidByPartnerId`
 * becomes a record of a fact rather than a claim on the business — which is the
 * distinction the credit turns on, and the reason `creditedPartnerId` exists.
 */

/**
 * Where the money came from, as one closed choice on the forms.
 *
 * A const tuple rather than a union so the Zod schemas can be built from it —
 * three server actions used to spell the same four options out by hand, and a
 * fifth added to only two of them is the kind of drift that shows up as a
 * silent validation failure on one form.
 */
export const FUNDING_SOURCES = ["NONE", "PARTNER", "TREASURY", "CREDIT", "REIMBURSED"] as const;

export type FundingSource = (typeof FUNDING_SOURCES)[number];

/**
 * The options a boost spend offers. Advertising is never bought on account —
 * the platform charges the card as it runs — so CREDIT has no meaning there.
 */
export const AD_FUNDING_SOURCES = ["NONE", "PARTNER", "TREASURY", "REIMBURSED"] as const;

/** How each choice reads on a form. */
export const fundingSourceLabel: Record<FundingSource, string> = {
  NONE: "Not recorded",
  PARTNER: "A partner's own money",
  TREASURY: "The treasury",
  CREDIT: "On credit — not paid yet",
  REIMBURSED: "A partner paid, the treasury paid them back",
};

/** The one-line explanation under each choice. */
export const fundingSourceHint: Record<FundingSource, string> = {
  NONE: "Counts against partner capital, since an untagged row is usually one a partner paid for and forgot to tag.",
  PARTNER: "Their capital funded it and stays in the business. Writes the matching investment credit.",
  TREASURY: "Comes straight out of the shared balance.",
  CREDIT: "Nothing has been paid yet, so it takes no capital — it becomes money owed to the supplier.",
  REIMBURSED: "The treasury is what paid, so it takes no capital from them — their name is kept as a record of who handed it over.",
};

/** The three columns the choice resolves to. */
export type FundingFlags = {
  paidByPartnerId: string | null;
  paidFromTreasury: boolean;
  onCredit: boolean;
};

/** Which choices need a partner picked before they mean anything. */
export function fundingNeedsPartner(source: FundingSource): boolean {
  return source === "PARTNER" || source === "REIMBURSED";
}

/** Which choices take money out of the treasury when they are saved. */
export function fundingSpendsTreasury(source: FundingSource): boolean {
  return source === "TREASURY" || source === "REIMBURSED";
}

/**
 * The form's choice, as the three columns. `partnerId` is ignored for the
 * choices that don't name one, so a stale id left in the form can't leak onto
 * a treasury-funded row.
 */
export function resolveFunding(
  source: FundingSource,
  partnerId: string | null,
): FundingFlags {
  return {
    paidByPartnerId: fundingNeedsPartner(source) ? (partnerId ?? null) : null,
    paidFromTreasury: fundingSpendsTreasury(source),
    onCredit: source === "CREDIT",
  };
}

/**
 * The reverse: what a stored row's columns say. Used by the edit forms to
 * reopen a row on the choice it was saved with, and by the spending page to
 * label it.
 *
 * Treasury is tested first, so a row carrying both columns reads as REIMBURSED
 * rather than as a plain partner-funded one. Every row written before this
 * existed carries at most one, and reads exactly as it did.
 */
export function fundingSourceOf(row: {
  paidByPartnerId?: string | null;
  paidFromTreasury?: boolean | null;
  onCredit?: boolean | null;
}): FundingSource {
  if (row.paidFromTreasury) return row.paidByPartnerId ? "REIMBURSED" : "TREASURY";
  if (row.paidByPartnerId) return "PARTNER";
  if (row.onCredit) return "CREDIT";
  return "NONE";
}

/**
 * How a saved row's funding reads in a list — short, and naming the partner
 * where there is one.
 *
 * A reimbursed row would otherwise read as a plain "Treasury" and lose the one
 * thing this state exists to keep: which of them actually handed the money
 * over. That is what somebody is looking for when they turn this column on.
 */
export function fundingLabel(row: {
  paidByPartnerId?: string | null;
  paidFromTreasury?: boolean | null;
  onCredit?: boolean | null;
  /** The partner's display name, when the row carries one. */
  paidBy?: string | null;
}): string {
  switch (fundingSourceOf(row)) {
    case "REIMBURSED":
      return row.paidBy ? `Treasury (${row.paidBy} fronted)` : "Treasury (a partner fronted)";
    case "TREASURY":
      return "Treasury";
    case "PARTNER":
      return row.paidBy ? `Partner: ${row.paidBy}` : "A partner";
    case "CREDIT":
      return "On credit";
    default:
      return "—";
  }
}

/**
 * Who gets the automatic INVESTMENT credit — nobody, on a reimbursed row.
 *
 * The credit exists to cancel the expense that the same purchase puts on that
 * partner, so the two together leave their capital where it was. A reimbursed
 * row is not their expense at all: `partnerBalances` skips it, because the
 * treasury is what paid. Writing the credit anyway would hand them capital they
 * never left in the business.
 *
 * Separate from `paidByPartnerId` on purpose. That column now answers "who
 * handed the money over", which is a fact about the day; this answers "whose
 * money is still in the business because of it", which is what the ledger is
 * for. They used to be the same question, and REIMBURSED is precisely the case
 * where they aren't.
 */
export function creditedPartnerId(flags: FundingFlags): string | null {
  return flags.paidFromTreasury ? null : flags.paidByPartnerId;
}
