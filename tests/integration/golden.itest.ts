import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resetDatabase } from "./harness";
import { buildDataset, type DatasetResult } from "../../scripts/demo/dataset";
import { computeFigures } from "./golden-figures";

/**
 * Golden Master: a fixed business, built through the real actions, whose money
 * figures are pinned in tests/golden/baseline.json.
 *
 *   yarn test:integration                      compare against the baseline
 *   UPDATE_GOLDEN=1 yarn test:integration      rewrite it (only on `main` code)
 *
 * The baseline was recorded from `main`. If this test fails on the upgrade
 * branch, a figure moved — which is exactly what must never happen.
 */
const BASELINE = resolve(process.cwd(), "tests/golden/baseline.json");

describe("golden master", () => {
  let result: DatasetResult;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T06:00:00.000Z"));
    await resetDatabase();
    result = await buildDataset({
      slug: "golden",
      workspaceName: "Golden Shop",
      startDay: "2026-07-15",
      days: 70,
      emailDomain: "golden.test",
      ordersPerDay: 2,
    });
  });
  afterAll(() => vi.useRealTimers());

  it("matches the recorded baseline to the paisa", async () => {
    const figures = await computeFigures(result.workspaceId, { from: "2026-08-01", to: "2026-09-15" });
    const text = JSON.stringify(figures, null, 2) + "\n";
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(BASELINE)) {
      mkdirSync(dirname(BASELINE), { recursive: true });
      writeFileSync(BASELINE, text);
      console.log("[golden] baseline written:", BASELINE);
      return;
    }
    const expected = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(JSON.parse(text)).toEqual(expected);
  });
});
