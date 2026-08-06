"use client";

/**
 * Remember which funding source was picked last, per workspace.
 *
 * The forms default to "None", which is the honest default for a shop that
 * hasn't decided — but it makes switching habits expensive. A shop moving to
 * buying from the treasury has to pick Treasury on every single purchase, and
 * the one they forget doesn't fail loudly: no treasury entry is written, no
 * partner credit either, and the cost quietly lands against partner capital
 * because an untagged row is assumed to be one a partner paid for and didn't
 * tag. Money leaves the treasury and the treasury never hears about it.
 *
 * So the last choice is remembered and pre-selected. localStorage rather than
 * the database: it's a convenience for whoever is typing, not a fact about the
 * business, and it should follow the person's habit on the device they enter
 * orders from. Per workspace, because a shop and its test workspace are
 * unlikely to be run the same way.
 */

export type FundingSource = "NONE" | "PARTNER" | "TREASURY";

const VALID: readonly FundingSource[] = ["NONE", "PARTNER", "TREASURY"];

const key = (workspace: string, form: string) => `funding:${workspace}:${form}`;

/**
 * What was chosen last for this form, or "NONE" when nothing is remembered.
 *
 * `form` separates the kinds of spending — stock and office supplies are often
 * funded differently, and a shop that buys inventory from the treasury may
 * still put a bus fare on someone's own card.
 */
export function readLastFundingSource(workspace: string, form: string): FundingSource {
  if (typeof window === "undefined") return "NONE";
  try {
    const raw = window.localStorage.getItem(key(workspace, form));
    return VALID.includes(raw as FundingSource) ? (raw as FundingSource) : "NONE";
  } catch {
    // Private browsing and blocked storage both throw. A forgotten preference
    // is not worth breaking the form over.
    return "NONE";
  }
}

export function writeLastFundingSource(
  workspace: string,
  form: string,
  value: FundingSource,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(workspace, form), value);
  } catch {
    /* see above */
  }
}
