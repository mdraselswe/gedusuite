import { describe, it, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { computeFigures } from "./golden-figures";

/**
 * Every money figure for every workspace in whatever database DATABASE_URL
 * points at, written to REALDATA_OUT. Used to compare the live code and the new
 * code on a local copy of real data. Skipped unless REALDATA_OUT is set; never
 * writes to the database.
 */
describe.skipIf(!process.env.REALDATA_OUT)("real-data figures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:00:00.000Z"));
  });
  afterAll(() => vi.useRealTimers());

  it("computes", async () => {
    const out: Record<string, unknown> = {};
    const ws = await prisma.workspace.findMany({ select: { id: true, slug: true }, orderBy: { slug: "asc" } });
    for (const w of ws) {
      out[w.slug] = {
        lastMonth: await computeFigures(w.id, { from: "2026-09-01", to: "2026-09-30" }),
        thisMonth: await computeFigures(w.id, { from: "2026-10-01", to: "2026-10-24" }),
      };
    }
    writeFileSync(process.env.REALDATA_OUT!, JSON.stringify(out, null, 2));
  });
});
