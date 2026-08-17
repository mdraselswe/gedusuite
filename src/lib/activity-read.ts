import { prisma } from "@/lib/prisma";
import type { FieldChanges } from "@/lib/activity";
import type { ActivityEntry } from "@/components/activity/activity-entries";
import { dhakaDayEnd, dhakaDayStart, DHAKA_TZ, formatDhakaTime } from "@/lib/dhaka-time";

/**
 * Reading the audit trail.
 *
 * Kept apart from `lib/activity.ts` (which writes it) so a page importing the
 * reader doesn't pull the writer's dependencies along, and so the two halves
 * are obviously two halves.
 */

/**
 * Dhaka time, because that is where the person reading this is — on the same
 * clock as the rest of the app, which shows "9:30 PM" everywhere else through
 * formatDhakaTime. This was the one screen still on a 24-hour one, and it sits
 * directly under a journey that isn't: two readings of 22:20 on one page is a
 * thing to get wrong at a glance, not a preference.
 */
const dayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DHAKA_TZ,
  day: "2-digit",
  month: "short",
});

function stamp(d: Date): string {
  return `${dayFmt.format(d)}, ${formatDhakaTime(d)}`;
}

function toEntry(row: {
  id: string;
  createdAt: Date;
  actorLabel: string;
  action: string;
  entity: string;
  entityId: string;
  entityLabel: string | null;
  summary: string;
  changes: unknown;
  groupId: string | null;
}): ActivityEntry {
  return {
    id: row.id,
    createdAt: stamp(row.createdAt),
    actorLabel: row.actorLabel,
    action: row.action as ActivityEntry["action"],
    entity: row.entity,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    summary: row.summary,
    changes: (row.changes as FieldChanges | null) ?? null,
    groupId: row.groupId,
  };
}

export type ActivityFilters = {
  /** Membership id, or "system" for the webhook and cron entries. */
  actor?: string;
  entity?: string;
  from?: string;
  to?: string;
};

const PAGE_SIZE = 50;

export async function readActivity(
  workspaceId: string,
  filters: ActivityFilters,
  page: number,
): Promise<{ entries: ActivityEntry[]; total: number; pageSize: number }> {
  const where = {
    workspaceId,
    ...(filters.actor === "system"
      ? { actorMembershipId: null }
      : filters.actor
        ? { actorMembershipId: filters.actor }
        : {}),
    ...(filters.entity ? { entity: filters.entity } : {}),
    ...(filters.from || filters.to
      ? {
          // Dhaka days — the log is stamped in Dhaka time, so a UTC window
          // would leave the evening's entries out of the day they show under.
          createdAt: {
            ...(filters.from ? { gte: dhakaDayStart(filters.from) } : {}),
            ...(filters.to ? { lte: dhakaDayEnd(filters.to) } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.activityLog.count({ where }),
  ]);
  return { entries: rows.map(toEntry), total, pageSize: PAGE_SIZE };
}

/**
 * One record's own history, newest first.
 *
 * Capped rather than paginated: a record with more than fifty changes is not
 * a record anyone is auditing line by line, and an unbounded query on a detail
 * page is how a page gets slow without anyone noticing.
 */
export async function readRecordHistory(
  workspaceId: string,
  entity: string,
  entityId: string,
  take = 50,
): Promise<ActivityEntry[]> {
  const rows = await prisma.activityLog.findMany({
    where: { workspaceId, entity, entityId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toEntry);
}

/** Who has ever appeared in this workspace's history, for the filter dropdown. */
export async function activityActors(
  workspaceId: string,
): Promise<{ id: string; label: string }[]> {
  const rows = await prisma.activityLog.findMany({
    where: { workspaceId },
    distinct: ["actorMembershipId"],
    select: { actorMembershipId: true, actorLabel: true },
    orderBy: { actorLabel: "asc" },
  });
  return rows.map((r) => ({
    // System entries have no membership; "system" is the filter value for them.
    id: r.actorMembershipId ?? "system",
    label: r.actorLabel,
  }));
}

/** Which kinds of record appear, so the filter only offers what exists. */
export async function activityEntities(workspaceId: string): Promise<string[]> {
  const rows = await prisma.activityLog.findMany({
    where: { workspaceId },
    distinct: ["entity"],
    select: { entity: true },
    orderBy: { entity: "asc" },
  });
  return rows.map((r) => r.entity);
}
