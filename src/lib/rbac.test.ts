import { describe, expect, it } from "vitest";
import { accessFor, can, effectiveAccess, satisfies } from "@/lib/rbac";

describe("satisfies", () => {
  it("lets a higher level stand in for a lower one", () => {
    expect(satisfies("edit", "view")).toBe(true);
    expect(satisfies("full", "add")).toBe(true);
    expect(satisfies("view", "view")).toBe(true);
  });

  it("doesn't let a lower level pass for a higher one", () => {
    expect(satisfies("view", "edit")).toBe(false);
    expect(satisfies("none", "view")).toBe(false);
  });
});

describe("accessFor", () => {
  it("gives the owner everything and staff nothing sensitive", () => {
    expect(accessFor("OWNER", "treasury")).toBe("full");
    expect(accessFor("STAFF", "treasury")).toBe("none");
    expect(accessFor("STAFF", "reports")).toBe("none");
    expect(accessFor("MANAGER", "treasury")).toBe("view");
  });
});

describe("effectiveAccess", () => {
  it("narrows when the override is lower than the role", () => {
    expect(effectiveAccess("MANAGER", "sales", { sales: "view" })).toBe("view");
    expect(effectiveAccess("OWNER", "treasury", { treasury: "none" })).toBe("none");
  });

  it("refuses to widen past the role", () => {
    // The whole point: this column must not be a way to hand out treasury
    // access without changing anyone's role.
    expect(effectiveAccess("STAFF", "treasury", { treasury: "full" })).toBe("none");
    expect(effectiveAccess("MANAGER", "treasury", { treasury: "full" })).toBe("view");
    expect(can("STAFF", "treasury", "full", { treasury: "full" })).toBe(false);
  });

  it("ignores junk without falling over", () => {
    expect(effectiveAccess("MANAGER", "sales", null)).toBe("edit");
    expect(effectiveAccess("MANAGER", "sales", "nonsense")).toBe("edit");
    expect(effectiveAccess("MANAGER", "sales", { sales: "wizard" })).toBe("edit");
    expect(effectiveAccess("MANAGER", "sales", { other: "none" })).toBe("edit");
  });
});
