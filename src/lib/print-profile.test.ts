import { describe, expect, it } from "vitest";
import {
  facebookContact,
  parsePrintProfile,
  resolvePrintProfile,
  websiteContact,
  whatsappContact,
} from "@/lib/print-profile";

describe("contacts", () => {
  it("normalises a website however it was pasted", () => {
    expect(websiteContact("https://shop.example.com/")).toEqual({
      display: "shop.example.com",
      url: "https://shop.example.com",
    });
    expect(websiteContact("  ")).toBeNull();
  });

  it("accepts a bare page name, a path or a full URL for Facebook", () => {
    expect(facebookContact("littlenest")?.url).toBe("https://facebook.com/littlenest");
    expect(facebookContact("@littlenest")?.display).toBe("facebook.com/littlenest");
    expect(facebookContact("https://www.facebook.com/little.nest/")?.url).toBe(
      "https://facebook.com/little.nest",
    );
    expect(facebookContact("")).toBeNull();
  });

  it("links a Bangladeshi mobile through wa.me with the country code", () => {
    expect(whatsappContact("01712-345678")).toEqual({
      display: "01712-345678",
      url: "https://wa.me/8801712345678",
    });
    expect(whatsappContact("+8801712345678")?.url).toBe("https://wa.me/8801712345678");
    expect(whatsappContact(null)).toBeNull();
  });
});

describe("resolvePrintProfile", () => {
  it("prints nothing about channels a shop does not have", () => {
    const p = resolvePrintProfile({ name: "Nila Fashion", logoUrl: null, websiteUrl: null, printProfile: null });
    expect(p.website).toBeNull();
    expect(p.facebook).toBeNull();
    expect(p.whatsapp).toBeNull();
    expect(p.headline).toBe("Nila Fashion");
    // and never another shop's words
    expect(JSON.stringify(p)).not.toMatch(/gedushop/i);
    expect(p.giftThanks).toContain("Nila Fashion");
  });

  it("uses what the owner wrote, and survives garbage in the column", () => {
    const p = resolvePrintProfile({
      name: "Nila",
      logoUrl: "data:image/png;base64,AAA",
      websiteUrl: "nila.example",
      printProfile: { facebook: "nila.bd", whatsapp: "01811111111", tagline: "Everyday style", giftQuote: "" },
    });
    expect(p.facebook?.display).toBe("facebook.com/nila.bd");
    expect(p.tagline).toBe("Everyday style");
    expect(p.giftQuote).toBe(""); // blank on purpose: hides the quote line
    expect(parsePrintProfile("not an object")).toEqual({});
    expect(parsePrintProfile({ tagline: 12 })).toEqual({});
  });
});
