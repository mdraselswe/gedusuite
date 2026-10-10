import { describe, expect, it } from "vitest";
import {
  PLANS,
  accessState,
  addMonths,
  daysLeft,
  effectivePlan,
  nextPeriodEnd,
  priceFor,
  withinLimit,
  type SubscriptionFacts,
} from "@/lib/plans";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("pricing", () => {
  it("charges ten months for a year", () => {
    expect(priceFor("BUSINESS", "MONTHLY")).toBe(1299);
    expect(priceFor("BUSINESS", "YEARLY")).toBe(12990);
  });
});

describe("accessState", () => {
  const sub = (o: Partial<SubscriptionFacts>): SubscriptionFacts => ({
    planKey: "BUSINESS",
    status: "ACTIVE",
    trialEndsAt: null,
    currentPeriodEnd: null,
    ...o,
  });

  it("no subscription row behaves like today: fully active", () => {
    expect(accessState(null)).toBe("active");
  });
  it("the founding plan never lapses, whatever its dates say", () => {
    expect(
      accessState(sub({ planKey: "LEGACY", currentPeriodEnd: d("2020-01-01") }), d("2026-10-10")),
    ).toBe("active");
  });
  it("a trial is a trial until its last day, then read-only", () => {
    const s = sub({ status: "TRIALING", trialEndsAt: d("2026-10-15") });
    expect(accessState(s, d("2026-10-10"))).toBe("trial");
    expect(accessState(s, d("2026-10-16"))).toBe("readonly");
  });
  it("a paid period gets a grace week before going read-only", () => {
    const s = sub({ currentPeriodEnd: d("2026-10-10") });
    expect(accessState(s, d("2026-10-09"))).toBe("active");
    expect(accessState(s, d("2026-10-14"))).toBe("grace");
    expect(accessState(s, d("2026-10-17"))).toBe("grace");
    expect(accessState(s, d("2026-10-18"))).toBe("readonly");
  });
  it("suspended and cancelled are read-only immediately", () => {
    expect(accessState(sub({ status: "SUSPENDED" }))).toBe("readonly");
    expect(accessState(sub({ status: "CANCELLED" }))).toBe("readonly");
  });
});

describe("effectivePlan", () => {
  it("a trial gets the Business limits", () => {
    expect(
      effectivePlan({ planKey: "STARTER", status: "TRIALING", trialEndsAt: null, currentPeriodEnd: null }).key,
    ).toBe("BUSINESS");
  });
  it("an unknown key falls back to unlimited rather than locking someone out", () => {
    expect(
      effectivePlan({ planKey: "WHAT", status: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null }).key,
    ).toBe("LEGACY");
  });
});

describe("limits", () => {
  it("allows up to the limit and refuses the next one", () => {
    expect(withinLimit(PLANS.STARTER, "ordersPerMonth", 199)).toEqual({ ok: true });
    expect(withinLimit(PLANS.STARTER, "ordersPerMonth", 200)).toEqual({ ok: false, limit: 200 });
  });
  it("null means unlimited", () => {
    expect(withinLimit(PLANS.PRO, "ordersPerMonth", 1_000_000)).toEqual({ ok: true });
  });
});

describe("dates", () => {
  it("adds months with day clamping", () => {
    expect(addMonths(d("2026-01-31"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(d("2028-01-31"), 1).toISOString().slice(0, 10)).toBe("2028-02-29");
    expect(addMonths(d("2026-10-10"), 12).toISOString().slice(0, 10)).toBe("2027-10-10");
  });
  it("renewing early extends from the current end, not from today", () => {
    const end = d("2026-11-01");
    expect(nextPeriodEnd(end, "MONTHLY", d("2026-10-20")).toISOString().slice(0, 10)).toBe("2026-12-01");
  });
  it("renewing after a lapse starts from today", () => {
    const end = d("2026-09-01");
    expect(nextPeriodEnd(end, "MONTHLY", d("2026-10-20")).toISOString().slice(0, 10)).toBe("2026-11-20");
  });
  it("counts whole days left, never negative", () => {
    expect(daysLeft(d("2026-10-15"), d("2026-10-10"))).toBe(5);
    expect(daysLeft(d("2026-10-01"), d("2026-10-10"))).toBe(0);
    expect(daysLeft(null)).toBeNull();
  });
});
