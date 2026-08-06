import { beforeEach, describe, expect, it, vi } from "vitest";
import { readLastFundingSource, writeLastFundingSource } from "@/lib/last-funding-source";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: fakeStorage() });
});

describe("last funding source", () => {
  it("defaults to None before anything has been chosen", () => {
    expect(readLastFundingSource("gedushop", "purchase")).toBe("NONE");
  });

  it("remembers what was chosen", () => {
    writeLastFundingSource("gedushop", "purchase", "TREASURY");
    expect(readLastFundingSource("gedushop", "purchase")).toBe("TREASURY");
  });

  it("keeps workspaces apart", () => {
    // A test workspace shouldn't teach the real shop how it funds things.
    writeLastFundingSource("gedushop", "purchase", "TREASURY");
    expect(readLastFundingSource("gedushop-2", "purchase")).toBe("NONE");
  });

  it("keeps the two kinds of spending apart", () => {
    // Stock from the treasury, a bus fare out of someone's pocket.
    writeLastFundingSource("gedushop", "purchase", "TREASURY");
    writeLastFundingSource("gedushop", "internal-purchase", "PARTNER");
    expect(readLastFundingSource("gedushop", "purchase")).toBe("TREASURY");
    expect(readLastFundingSource("gedushop", "internal-purchase")).toBe("PARTNER");
  });

  it("ignores a value that isn't a funding source", () => {
    window.localStorage.setItem("funding:gedushop:purchase", "WHATEVER");
    expect(readLastFundingSource("gedushop", "purchase")).toBe("NONE");
  });

  it("falls back to None when storage throws", () => {
    // Private browsing, or storage blocked outright.
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readLastFundingSource("gedushop", "purchase")).toBe("NONE");
    expect(() => writeLastFundingSource("gedushop", "purchase", "TREASURY")).not.toThrow();
  });

  it("says None when there's no window at all", () => {
    vi.stubGlobal("window", undefined);
    expect(readLastFundingSource("gedushop", "purchase")).toBe("NONE");
  });
});
