import { describe, expect, it } from "vitest";
import { phoneSearchTerms } from "@/lib/phone";

describe("phoneSearchTerms", () => {
  it("returns nothing for a name, so a name search stays a name search", () => {
    expect(phoneSearchTerms("Rajib Hasan")).toEqual([]);
    expect(phoneSearchTerms("")).toEqual([]);
    expect(phoneSearchTerms(null)).toEqual([]);
  });

  it("is a single term when the query is already the stored shape", () => {
    expect(phoneSearchTerms("01712345678")).toEqual(["01712345678"]);
  });

  it("reaches a normalized row from a country-code query", () => {
    expect(phoneSearchTerms("+8801712345678")).toContain("01712345678");
  });

  it("reaches a normalized row from a query missing the leading zero", () => {
    expect(phoneSearchTerms("1712345678")).toContain("01712345678");
  });

  it("keeps the separators typed, for a delivery phone stored as written", () => {
    expect(phoneSearchTerms("01712 345678")).toEqual(["01712345678", "01712 345678"]);
  });

  it("keeps a partial number usable as a substring", () => {
    expect(phoneSearchTerms("345678")).toEqual(["345678"]);
  });

  it("does not keep the raw query when it mixes digits into text", () => {
    expect(phoneSearchTerms("Rajib 01712345678")).toEqual(["01712345678"]);
  });
});
