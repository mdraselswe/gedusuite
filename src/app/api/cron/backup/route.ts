import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { denyCron } from "@/lib/cron-auth";
import { buildSnapshot } from "@/lib/backup";
import { pruneOldActivity } from "@/lib/activity-retention";
import { purgeExpiredRateLimits } from "@/lib/rate-limit";
import { uploadOffsiteSnapshot } from "@/lib/offsite-backup";

const KEEP = 10;

/**
 * One invocation has a hard ceiling on serverless. Workspaces are taken
 * least-recently-backed-up first and the loop stops with time to spare, so a
 * run that cannot reach everybody simply picks up where it left off next time
 * instead of being killed halfway through somebody's snapshot.
 */
export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;

/** How long an offline-queue idempotency key is worth keeping. */
const PROCESSED_MUTATION_DAYS = 14;

// Scheduled JSON backup for every workspace that opted in (BackupSetting.autoJson).
// Wired to Vercel Cron in vercel.json. Protected by CRON_SECRET.
export async function GET(req: NextRequest) {
  const denied = denyCron(req);
  if (denied) return denied;

  const started = Date.now();
  const settings = await prisma.backupSetting.findMany({
    where: { autoJson: true },
    select: { workspaceId: true },
    orderBy: { lastJsonAt: { sort: "asc", nulls: "first" } },
  });

  const results: { workspaceId: string; status: string; offsite?: string }[] = [];
  let deferred = 0;

  for (const s of settings) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      deferred++;
      continue;
    }
    const workspaceId = s.workspaceId;
    try {
      const snapshot = await buildSnapshot(workspaceId);
      const json = JSON.stringify(snapshot);

      await prisma.backupLog.create({
        data: {
          workspaceId,
          type: "JSON",
          status: "SUCCESS",
          triggeredBy: null,
          error: "scheduled",
          payload: json,
        },
      });
      await prisma.backupSetting.update({
        where: { workspaceId },
        data: { lastJsonAt: new Date() },
      });

      // Prune old in-DB payloads.
      const keep = await prisma.backupLog.findMany({
        where: { workspaceId, type: "JSON", payload: { not: null } },
        orderBy: { createdAt: "desc" },
        take: KEEP,
        select: { id: true },
      });
      await prisma.backupLog.updateMany({
        where: {
          workspaceId,
          type: "JSON",
          payload: { not: null },
          id: { notIn: keep.map((k) => k.id) },
        },
        data: { payload: null },
      });

      // A second copy somewhere that does not share this database's fate. A
      // failure here is reported, never allowed to undo the backup above.
      const off = await uploadOffsiteSnapshot(workspaceId, json);
      if (!off.ok && !off.skipped) {
        const ws = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { slug: true },
        });
        await prisma.notification.create({
          data: {
            workspaceId,
            type: "GENERAL",
            message: `Off-site backup copy failed: ${off.error}`,
            link: ws ? `/${ws.slug}/settings/backup` : null,
          },
        });
      }

      results.push({
        workspaceId,
        status: "SUCCESS",
        offsite: off.ok ? "uploaded" : off.skipped ? "not configured" : "failed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { slug: true },
      });
      await prisma.backupLog.create({
        data: { workspaceId, type: "JSON", status: "FAILED", triggeredBy: null, error: `scheduled: ${msg}` },
      });
      await prisma.notification.create({
        data: {
          workspaceId,
          type: "GENERAL",
          message: `Scheduled backup failed: ${msg}`,
          link: ws ? `/${ws.slug}/settings/backup` : null,
        },
      });
      results.push({ workspaceId, status: "FAILED" });
    }
  }

  // Offline-queue keys, which nothing had ever deleted. They exist to stop a
  // retried write from being applied twice, so they only need to outlive the
  // outbox's retry window — after that they are a table that grows for the
  // life of the deployment and is never read. A fortnight is far longer than
  // any queued write survives on a phone, and short enough that this stays a
  // handful of rows.
  const cutoff = new Date(Date.now() - PROCESSED_MUTATION_DAYS * 86_400_000);
  const pruned = await prisma.processedMutation.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  const activityPruned = await pruneOldActivity();
  const rateLimitsPurged = await purgeExpiredRateLimits().catch(() => 0);

  return NextResponse.json({
    ok: true,
    ran: results.length,
    deferred,
    results,
    pruned: pruned.count,
    activityPruned,
    rateLimitsPurged,
  });
}
