"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireAccess } from "@/lib/authz";
import { buildSnapshot, computeBackupSummary } from "@/lib/backup";
import { syncSnapshotForUser, uploadJsonBackupToDrive } from "@/lib/google";
import {
  clientForConnection,
  revokeToken,
  personalBackupConfigured,
} from "@/lib/google-personal";
import { encrypt } from "@/lib/crypto";

export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/** Personal connection status for the current user (no secrets returned). */
export async function getPersonalStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  sheetUrl: string | null;
  lastJsonUrl: string | null;
  lastSyncedAt: string | null;
}> {
  const user = await requireUser();
  const conn = await prisma.userGoogleConnection.findUnique({ where: { userId: user.id } });
  return {
    configured: personalBackupConfigured(),
    connected: !!conn,
    sheetUrl: conn?.sheetId ? `https://docs.google.com/spreadsheets/d/${conn.sheetId}` : null,
    lastJsonUrl: conn?.lastJsonUrl ?? null,
    lastSyncedAt: conn?.lastSyncedAt?.toISOString().slice(0, 16).replace("T", " ") ?? null,
  };
}

/** Write the current workspace's data into the user's own Google Sheet. */
export async function personalSyncNow(slug: string): Promise<Result<{ url: string }>> {
  const gate = await requireAccess(slug, "backup", "view");
  if (!gate.ok) return gate;
  const userId = gate.access.userId;
  const workspaceId = gate.access.workspaceId;

  const conn = await prisma.userGoogleConnection.findUnique({ where: { userId } });
  if (!conn) return { ok: false, error: "Connect your Google account first" };

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
    const { sheetId, url } = await syncSnapshotForUser(client, snapshot, summary, conn.sheetId);

    const filename = `gedusuite-backup-${snapshot.exportedAt.slice(0, 10)}.json`;
    const { url: jsonUrl } = await uploadJsonBackupToDrive(
      client,
      JSON.stringify(snapshot, null, 2),
      filename,
    );

    // Persist any refreshed access token + the (possibly new) sheet id.
    const creds = client.credentials;
    await prisma.userGoogleConnection.update({
      where: { userId },
      data: {
        sheetId,
        workspaceId,
        lastJsonUrl: jsonUrl,
        lastSyncedAt: new Date(),
        ...(creds.access_token ? { accessToken: encrypt(creds.access_token) } : {}),
        ...(creds.expiry_date ? { expiryDate: BigInt(creds.expiry_date) } : {}),
      },
    });

    revalidatePath(`/${slug}/settings/backup`);
    return { ok: true, url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, error: `Personal sync failed: ${msg}` };
  }
}

/** Disconnect personal backup: revoke the token and delete the connection. */
export async function disconnectPersonal(slug: string): Promise<Result> {
  const user = await requireUser();
  const conn = await prisma.userGoogleConnection.findUnique({ where: { userId: user.id } });
  if (!conn) return { ok: true };
  await revokeToken(conn.accessToken);
  await prisma.userGoogleConnection.delete({ where: { userId: user.id } });
  revalidatePath(`/${slug}/settings/backup`);
  return { ok: true };
}
