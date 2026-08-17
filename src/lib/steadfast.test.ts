import { describe, expect, it } from "vitest";
import { buildInvoice, buildItemDescription, normalizePhone } from "@/lib/steadfast";
import { detectDistrict, detectSuburbanArea, DISTRICTS, mentionsDistrict } from "@/lib/bd-locations";
import { codCollectable } from "@/lib/order-cash";

describe("normalizePhone", () => {
  it("lands every stored variant of one number on the same answer", () => {
    // The point of taking the LAST ten digits: the same customer typed four
    // different ways still gets one parcel to one phone.
    for (const input of [
      "01309055966",
      "+8801309055966",
      "8801309055966",
      "01309-055966",
      " 01309 055 966 ",
    ]) {
      expect(normalizePhone(input)).toBe("01309055966");
    }
  });

  it("sends the local format Steadfast's own plugin sends", () => {
    // The docs show +880…; the plugin posts 0…. The plugin is the one with
    // 8,000 shops behind it.
    expect(normalizePhone("+8801712345678")).toBe("01712345678");
  });

  it("refuses anything that is not a BD mobile number", () => {
    expect(normalizePhone("0212345678")).toBeNull(); // landline
    expect(normalizePhone("01212345678")).toBeNull(); // no operator uses 012
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("buildInvoice", () => {
  it("makes a number a person can read out and find in the app", () => {
    expect(buildInvoice("GS", 1042)).toBe("GS-1042");
  });

  it("strips whatever a workspace name throws at it", () => {
    expect(buildInvoice("gedu shop!", 7)).toBe("GEDUSHOP-7");
    expect(buildInvoice("   ", 7)).toBe("7");
  });
});

describe("buildItemDescription", () => {
  it("counts first, because the rider counts boxes", () => {
    expect(
      buildItemDescription([
        { name: "Baby Lotion 200ml", quantity: 2 },
        { name: "Diaper M", quantity: 1 },
      ]),
    ).toBe("2x Baby Lotion 200ml, 1x Diaper M");
  });

  it("truncates rather than overflowing a label field", () => {
    const long = buildItemDescription([{ name: "x".repeat(500), quantity: 1 }], 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("detectDistrict", () => {
  it("finds the district in an ordinary address", () => {
    expect(detectDistrict("Bashundhara R/A, Block C, Road 5, Vatara, Dhaka")).toBe("Dhaka");
    expect(detectDistrict("Village Road, Debidwar, Cumilla")).toBe("Cumilla");
  });

  it("matches on word boundaries, not substrings", () => {
    // Dhakadakshin is in Sylhet. It must not read as Dhaka.
    expect(detectDistrict("Dhakadakshin Bazar, Golapganj")).toBeNull();
  });

  it("accepts the spellings half the country still types", () => {
    // Warning on "Comilla" would train people to ignore the warning.
    expect(detectDistrict("Kandirpar, Comilla")).toBe("Cumilla");
    expect(detectDistrict("Agrabad, Chittagong")).toBe("Chattogram");
    expect(detectDistrict("Bogra sadar")).toBe("Bogura");
  });

  it("prefers the longer name when one contains the other", () => {
    // "Chapainawabganj" contains "Nawabganj", which is a different place.
    expect(detectDistrict("Shibganj, Chapainawabganj")).toBe("Chapainawabganj");
  });

  it("is case-insensitive", () => {
    expect(detectDistrict("mirpur 10, DHAKA")).toBe("Dhaka");
  });

  it("says null rather than guessing", () => {
    // A perfectly deliverable address that names no district we know. The
    // dialog warns; it does not refuse.
    expect(detectDistrict("Bashundhara R/A, Block C, Road 5")).toBeNull();
    expect(detectDistrict("মিরপুর ১০, ঢাকা")).toBeNull();
    expect(detectDistrict("")).toBeNull();
    expect(detectDistrict(null)).toBeNull();
  });

  it("backs mentionsDistrict", () => {
    expect(mentionsDistrict("Zindabazar, Sylhet")).toBe(true);
    expect(mentionsDistrict("behind the big mosque")).toBe(false);
  });
});

describe("detectSuburbanArea — the middle rate nobody remembers to pick", () => {
  it("names the area a courier prices between Dhaka and outside it", () => {
    // The parcel this exists for: booked on the Dhaka City rate at 65, billed
    // at the sub-urban 105, and only noticed two days later.
    expect(
      detectSuburbanArea("Khejurbag satpakhi vai vai road Keraniganj Dhaka"),
    ).toBe("Keraniganj");
    expect(detectSuburbanArea("Al-Madina Washing Plant Ltd. Hemaytpur, Savar, Dhaka")).toBe(
      "Savar",
    );
    expect(detectSuburbanArea("Board Bazar, Gazipur")).toBe("Board Bazar");
  });

  it("leaves Dhaka proper and the rest of the country alone", () => {
    expect(detectSuburbanArea("118/17 kusum sritikunjo, Shewrapara, Mirpur, Dhaka")).toBeNull();
    expect(detectSuburbanArea("Thakurgaon Road, Sadar, Thakurgaon")).toBeNull();
    expect(detectSuburbanArea("")).toBeNull();
    expect(detectSuburbanArea(null)).toBeNull();
  });

  it("matches on the whole word, not inside one", () => {
    // Savarkar is a surname; Doharia is in Pabna. Neither is a middle rate.
    expect(detectSuburbanArea("House of Mr Savarkar, Banani, Dhaka")).toBeNull();
    expect(detectSuburbanArea("Doharia bazar, Pabna")).toBeNull();
  });

  it("stays quiet on Nawabganj, which names two places 300km apart", () => {
    // Dhaka's Nawabganj belongs on the middle rate and Chapainawabganj does
    // not, and one line of free text cannot tell them apart. A warning that
    // fires on the wrong parcel stops being read on the right one.
    expect(detectSuburbanArea("Nawabganj bazar, Dhaka")).toBeNull();
    expect(detectSuburbanArea("Shibganj, Chapainawabganj")).toBeNull();
  });
});

describe("codCollectable — what the parcel tells the courier to collect", () => {
  it("is the outstanding amount only when the courier is the one collecting", () => {
    expect(codCollectable("COURIER_COLLECTION", 1250)).toBe(1250);
  });

  it("is zero for every other payment method, however unpaid the order looks", () => {
    // The bug this test exists for: booking used the outstanding amount alone,
    // so an order the customer pays by bKash went out with 1,250 on the label.
    // The courier collects it, the customer has now paid twice, and the COD
    // fee was quoted at zero because the rest of the app knew better.
    for (const method of ["BKASH", "NAGAD", "CASH", "OTHER"]) {
      expect(codCollectable(method, 1250)).toBe(0);
    }
  });

  it("never sends a negative amount", () => {
    expect(codCollectable("COURIER_COLLECTION", -50)).toBe(0);
  });
});

describe("the district list", () => {
  it("has all 64", () => {
    expect(DISTRICTS).toHaveLength(64);
  });

  it("carries the names in use today", () => {
    for (const current of ["Cumilla", "Chattogram", "Jashore", "Bogura", "Barishal"]) {
      expect(DISTRICTS).toContain(current);
    }
    for (const old of ["Comilla", "Chittagong", "Jessore", "Bogra", "Barisal"]) {
      expect(DISTRICTS).not.toContain(old);
    }
  });
});
