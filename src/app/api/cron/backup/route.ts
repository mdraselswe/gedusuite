import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildSnapshot } from "@/lib/backup";
import { isGoogleConfigured, uploadJsonToDrive } from "@/lib/google";

const KEEP = 10;

// Scheduled JSON backup for every workspace that opted in (BackupSetting.autoJson).
// Wired to Vercel Cron in vercel.json. Protected by CRON_SECRET.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const settings = await prisma.backupSetting.findMany({
    where: { autoJson: true },
    select: { workspaceId: true, driveFolderId: true },
  });

  const results: { workspaceId: string; status: string }[] = [];

  for (const s of settings) {
    const workspaceId = s.workspaceId;
    try {
      const snapshot = await buildSnapshot(workspaceId);
      const json = JSON.stringify(snapshot);

      let fileUrl: string | null = null;
      if (isGoogleConfigured()) {
        try {
          const up = await uploadJsonToDrive(
            `gedusuite-backup-${snapshot.exportedAt.slice(0, 10)}.json`,
            json,
            s.driveFolderId ?? null,
          );
          fileUrl = up.url;
        } catch {
          fileUrl = null;
        }
      }

      await prisma.backupLog.create({
        data: {
          workspaceId,
          type: "JSON",
          status: "SUCCESS",
          triggeredBy: null,
          error: "scheduled",
          fileUrl,
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

      results.push({ workspaceId, status: "SUCCESS" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await prisma.backupLog.create({
        data: { workspaceId, type: "JSON", status: "FAILED", triggeredBy: null, error: `scheduled: ${msg}` },
      });
      await prisma.notification.create({
        data: { workspaceId, type: "GENERAL", message: `Scheduled backup failed: ${msg}` },
      });
      results.push({ workspaceId, status: "FAILED" });
    }
  }

  return NextResponse.json({ ok: true, ran: results.length, results });
}
