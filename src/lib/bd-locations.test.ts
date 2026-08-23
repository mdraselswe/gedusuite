import { describe, expect, it } from "vitest";
import { districtFromIso, expandIsoDistricts } from "@/lib/bd-locations";

/**
 * The checkout stores the district as an ISO 3166-2:BD code, so the codes have
 * to be readable everywhere a district is shown. Only the code turns into a
 * name — anything else in the field is somebody's own writing.
 */
describe("districtFromIso", () => {
  it("names a code", () => {
    expect(districtFromIso("BD-13")).toBe("Dhaka");
    expect(districtFromIso("BD-10")).toBe("Chattogram");
    expect(districtFromIso("BD-08")).toBe("Cumilla");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(districtFromIso(" bd-63 ")).toBe("Tangail");
  });

  it("hands back anything that isn't a code", () => {
    expect(districtFromIso("Dhaka")).toBe("Dhaka");
    // Not in the table: still what the checkout meant by it, so still shown.
    expect(districtFromIso("BD-99")).toBe("BD-99");
    expect(districtFromIso("")).toBeNull();
    expect(districtFromIso(null)).toBeNull();
  });
});

describe("expandIsoDistricts", () => {
  it("names codes inside a written address, leaving the rest alone", () => {
    expect(expandIsoDistricts("Konapara, Police fari, Demra, BD-13")).toBe(
      "Konapara, Police fari, Demra, Dhaka",
    );
  });

  it("does not touch a word that merely starts with the code", () => {
    expect(expandIsoDistricts("BD-13A road")).toBe("BD-13A road");
  });

  it("leaves an address with no code exactly as it was", () => {
    const written = "House-71, Road-27,  Gulshan-1\nDhaka";
    expect(expandIsoDistricts(written)).toBe(written);
  });
});
