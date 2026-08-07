import { describe, expect, it } from "vitest";
import { z } from "zod";
import { failed, firstIssue } from "@/lib/form";

const Schema = z.object({
  amount: z.coerce.number().positive("Amount must be > 0"),
  source: z.string().trim().min(1, "Source is required"),
  items: z.array(z.object({ unitPrice: z.coerce.number().nonnegative("Price must be ≥ 0") })),
});

const fail = (input: unknown) => {
  const r = Schema.safeParse(input);
  if (r.success) throw new Error("expected a validation failure");
  return r.error;
};

describe("firstIssue", () => {
  it("keeps the field, which is the part that used to be thrown away", () => {
    // Every action did `issues[0]?.message` — the sentence survived and the
    // path didn't, so the message arrived as a toast over a form with eleven
    // inputs and finding the right box was the reader's problem.
    const issue = firstIssue(fail({ amount: 0, source: "x", items: [] }));
    expect(issue.message).toBe("Amount must be > 0");
    expect(issue.field).toBe("amount");
  });

  it("joins a nested path the way a form names it", () => {
    const issue = firstIssue(fail({ amount: 5, source: "x", items: [{ unitPrice: -1 }] }));
    expect(issue.field).toBe("items.0.unitPrice");
  });

  it("leaves the field undefined when the failure belongs to no one box", () => {
    const r = z.object({}).refine(() => false, "Nothing adds up").safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error).field).toBeUndefined();
  });
});

describe("failed", () => {
  it("is the shape every action already returned, plus the field", () => {
    const res = failed(fail({ amount: 0, source: "x", items: [] }));
    // ok/error unchanged, so a form that ignores `field` behaves as before.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Amount must be > 0");
    expect(res.field).toBe("amount");
  });
});
