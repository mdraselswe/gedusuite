"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import {
  buildSnapshot,
  validateSnapshot,
  restoreSnapshot,
  type RestoreMode,
  type SnapshotCounts,
} from "@/lib/backup";
import {
  isGoogleConfigured,
  syncSnapshotToSheets,
  uploadJsonToDrive,
} from "@/lib/google";

export type BackupResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const KEEP_JSON_PAYLOADS = 10;

/** Notify the workspace (Owner sees it) when a backup/restore fails. */
async function alertFailure(workspaceId: string, message: string) {
  await prisma.notification.create({
    data: { workspaceId, type: "GENERAL", message },
  });
}

/** Prune stored JSON payloads beyond the most recent N (metadata is kept). */
async function pruneJsonPayloads(workspaceId: string) {
  const keep = await prisma.backupLog.findMany({
    where: { workspaceId, type: "JSON", payload: { not: null } },
    orderBy: { createdAt: "desc" },
    take: KEEP_JSON_PAYLOADS,
    select: { id: true },
  });
  const keepIds = keep.map((k) => k.id);
  await prisma.backupLog.updateMany({
    where: { workspaceId, type: "JSON", payload: { not: null }, id: { notIn: keepIds } },
    data: { payload: null },
  });
}

/** Manual JSON backup — returns the JSON so the client can download it. */
export async function backupNow(
  slug: string,
): Promise<BackupResult<{ json: string; filename: string; driveUrl: string | null }>> {
  const gate = await requireAccess(slug, "backup", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  try {
    const snapshot = await buildSnapshot(workspaceId);
    const json = JSON.stringify(snapshot, null, 2);
    const filename = `gedusuite-backup-${snapshot.exportedAt.slice(0, 10)}.json`;

    // Optionally push to Drive if configured + a folder is set.
    let driveUrl: string | null = null;
    const setting = await prisma.backupSetting.findUnique({ where: { workspaceId } });
    if (isGoogleConfigured()) {
      try {
        const up = await uploadJsonToDrive(filename, json, setting?.driveFolderId ?? null);
        driveUrl = up.url;
      } catch {
        // Drive upload failure shouldn't block the local download.
        driveUrl = null;
      }
    }

    await prisma.backupLog.create({
      data: {
        workspaceId,
        type: "JSON",
        status: "SUCCESS",
        triggeredBy: gate.access.userId,
        fileUrl: driveUrl,
        payload: json,
      },
    });
    await prisma.backupSetting.upsert({
      where: { workspaceId },
      create: { workspaceId, lastJsonAt: new Date() },
      update: { lastJsonAt: new Date() },
    });
    await pruneJsonPayloads(workspaceId);

    revalidatePath(`/${slug}/settings/backup`);
    return { ok: true, json, filename, driveUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await prisma.backupLog.create({
      data: { workspaceId, type: "JSON", status: "FAILED", triggeredBy: gate.access.userId, error: msg },
    });
    await alertFailure(workspaceId, `JSON backup failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Sync all modules to the workspace's Google Sheet. */
export async function syncSheets(slug: string): Promise<BackupResult<{ url: string }>> {
  const gate = await requireAccess(slug, "backup", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  if (!isGoogleConfigured()) {
    return { ok: false, error: "Google integration is not configured on the server" };
  }

  try {
    const [snapshot, ws, setting] = await Promise.all([
      buildSnapshot(workspaceId),
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
      prisma.backupSetting.findUnique({ where: { workspaceId } }),
    ]);
    const { sheetId, url } = await syncSnapshotToSheets(
      snapshot,
      ws?.name ?? "Workspace",
      setting?.googleSheetId ?? null,
    );
    await prisma.backupSetting.upsert({
      where: { workspaceId },
      create: { workspaceId, googleSheetId: sheetId, lastSheetsAt: new Date() },
      update: { googleSheetId: sheetId, lastSheetsAt: new Date() },
    });
    await prisma.backupLog.create({
      data: {
        workspaceId,
        type: "SHEETS",
        status: "SUCCESS",
        triggeredBy: gate.access.userId,
        fileUrl: url,
      },
    });
    revalidatePath(`/${slug}/settings/backup`);
    return { ok: true, url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await prisma.backupLog.create({
      data: { workspaceId, type: "SHEETS", status: "FAILED", triggeredBy: gate.access.userId, error: msg },
    });
    await alertFailure(workspaceId, `Google Sheets sync failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Validate an uploaded JSON string and return per-table counts (no changes). */
export async function previewRestore(
  slug: string,
  jsonString: string,
): Promise<BackupResult<{ counts: SnapshotCounts }>> {
  const gate = await requireAccess(slug, "backup", "full");
  if (!gate.ok) return gate;
  let data: unknown;
  try {
    data = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  const v = validateSnapshot(data);
  if (!v.ok) return v;
  return { ok: true, counts: v.counts };
}

/** Restore from an uploaded JSON string. Takes a safety snapshot first. */
export async function applyRestore(
  slug: string,
  jsonString: string,
  mode: RestoreMode,
): Promise<BackupResult<{ inserted: SnapshotCounts }>> {
  const gate = await requireAccess(slug, "backup", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  let data: unknown;
  try {
    data = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  const v = validateSnapshot(data);
  if (!v.ok) return v;

  try {
    // Safety snapshot of current data before we touch anything.
    const safety = await buildSnapshot(workspaceId);
    await prisma.backupLog.create({
      data: {
        workspaceId,
        type: "JSON",
        status: "SUCCESS",
        triggeredBy: gate.access.userId,
        error: "auto-snapshot before restore",
        payload: JSON.stringify(safety),
      },
    });
    await pruneJsonPayloads(workspaceId);

    const { inserted } = await restoreSnapshot(workspaceId, v.snapshot, mode);

    await prisma.notification.create({
      data: {
        workspaceId,
        type: "GENERAL",
        message: `Restore completed (${mode.toLowerCase()})`,
      },
    });
    revalidatePath(`/${slug}/settings/backup`);
    return { ok: true, inserted };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await prisma.backupLog.create({
      data: { workspaceId, type: "JSON", status: "FAILED", triggeredBy: gate.access.userId, error: `restore: ${msg}` },
    });
    await alertFailure(workspaceId, `Restore failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function updateBackupSetting(
  slug: string,
  formData: FormData,
): Promise<BackupResult> {
  const gate = await requireAccess(slug, "backup", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const googleSheetId = String(formData.get("googleSheetId") ?? "").trim() || null;
  const driveFolderId = String(formData.get("driveFolderId") ?? "").trim() || null;
  const autoJson = formData.get("autoJson") === "true" || formData.get("autoJson") === "on";

  await prisma.backupSetting.upsert({
    where: { workspaceId },
    create: { workspaceId, googleSheetId, driveFolderId, autoJson },
    update: { googleSheetId, driveFolderId, autoJson },
  });
  revalidatePath(`/${slug}/settings/backup`);
  return { ok: true };
}
