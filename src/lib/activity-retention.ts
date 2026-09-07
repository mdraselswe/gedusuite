import { prisma } from "@/lib/prisma";

export const ACTIVITY_RETENTION_MONTHS = 12;

export function activityRetentionCutoff(now = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return cutoff;
}

export async function pruneOldActivity(now = new Date()): Promise<number> {
  const cutoff = activityRetentionCutoff(now);
  const res = await prisma.activityLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return res.count;
}
