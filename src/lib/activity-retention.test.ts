import { describe, expect, it, vi } from "vitest";
import { activityRetentionCutoff, pruneOldActivity } from "@/lib/activity-retention";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    activityLog: {
      deleteMany: vi.fn(),
    },
  },
}));

describe("activity retention", () => {
  it("keeps only the last twelve months of activity", () => {
    const cutoff = activityRetentionCutoff(new Date("2026-09-07T10:30:00.000Z"));
    expect(cutoff.toISOString()).toBe("2025-09-07T10:30:00.000Z");
  });

  it("deletes activity older than the retention cutoff", async () => {
    vi.mocked(prisma.activityLog.deleteMany).mockResolvedValueOnce({ count: 7 });

    await expect(pruneOldActivity(new Date("2026-09-07T10:30:00.000Z"))).resolves.toBe(7);
    expect(prisma.activityLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2025-09-07T10:30:00.000Z") } },
    });
  });
});
