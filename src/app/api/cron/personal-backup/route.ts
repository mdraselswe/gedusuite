import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildSnapshot, computeBackupSummary } from "@/lib/backup";
import { syncSnapshotForUser } from "@/lib/google";
import { clientForConnection } from "@/lib/google-personal";
import { encrypt } from "@/lib/crypto";

// Scheduled sync of every user's personal Google Sheet backup. Runs alongside
// the manual "Sync now" button — same buildSnapshot/syncSnapshotForUser path,
// just triggered on a schedule instead of a click. Wired to Vercel Cron in
// vercel.json. Protected by CRON_SECRET.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const connections = await prisma.userGoogleConnection.findMany({
    where: { workspaceId: { not: null } },
  });

  const results: { userId: string; status: string }[] = [];

  for (const conn of connections) {
    const workspaceId = conn.workspaceId;
    if (!workspaceId) continue;
    try {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true },
      });
      const [snapshot, summary] = await Promise.all([
        buildSnapshot(workspaceId),
        computeBackupSummary(workspaceId, ws?.name ?? "Workspace"),
      ]);

      const client = clientForConnection(conn);
      const { sheetId } = await syncSnapshotForUser(client, snapshot, summary, conn.sheetId);

      const creds = client.credentials;
      await prisma.userGoogleConnection.update({
        where: { userId: conn.userId },
        data: {
          sheetId,
          lastSyncedAt: new Date(),
          ...(creds.access_token ? { accessToken: encrypt(creds.access_token) } : {}),
          ...(creds.expiry_date ? { expiryDate: BigInt(creds.expiry_date) } : {}),
        },
      });

      await prisma.backupLog.create({
        data: {
          workspaceId,
          type: "SHEETS",
          status: "SUCCESS",
          triggeredBy: null,
          error: "scheduled (personal)",
        },
      });
      await prisma.notification.deleteMany({
        where: { workspaceId, dedupeKey: `personal-backup-failed:${conn.userId}` },
      });

      results.push({ userId: conn.userId, status: "SUCCESS" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await prisma.backupLog.create({
        data: {
          workspaceId,
          type: "SHEETS",
          status: "FAILED",
          triggeredBy: null,
          error: `scheduled (personal): ${msg}`,
        },
      });
      const user = await prisma.user.findUnique({
        where: { id: conn.userId },
        select: { name: true, email: true },
      });
      await prisma.notification.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: `personal-backup-failed:${conn.userId}` } },
        create: {
          workspaceId,
          type: "GENERAL",
          dedupeKey: `personal-backup-failed:${conn.userId}`,
          message: `Personal backup sync failed for ${user?.name ?? user?.email ?? "a user"}: ${msg}. They should reconnect from Settings → Backup if this keeps happening.`,
        },
        update: {
          message: `Personal backup sync failed for ${user?.name ?? user?.email ?? "a user"}: ${msg}. They should reconnect from Settings → Backup if this keeps happening.`,
          read: false,
          createdAt: new Date(),
        },
      });
      results.push({ userId: conn.userId, status: "FAILED" });
    }
  }

  return NextResponse.json({ ok: true, ran: results.length, results });
}
