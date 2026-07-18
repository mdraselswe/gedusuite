import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isGoogleConfigured } from "@/lib/google";
import { BackupManager } from "@/components/backup/backup-manager";
import { PersonalBackupCard } from "@/components/backup/personal-backup-card";
import { getPersonalStatus } from "@/server/actions/personal-backup";
import { serverT } from "@/lib/session";

export default async function BackupSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "backup", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canManage = can(access.role, "backup", "full", access.permissions);

  const [setting, logs, personal] = await Promise.all([
    prisma.backupSetting.findUnique({ where: { workspaceId } }),
    prisma.backupLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    getPersonalStatus(),
  ]);

  const logRows = logs.map((l) => ({
    id: l.id,
    type: l.type,
    status: l.status,
    fileUrl: l.fileUrl,
    note: l.error,
    createdAt: l.createdAt.toISOString().slice(0, 16).replace("T", " "),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">{(await serverT())("backupRecovery")}</h1>
      <BackupManager
        slug={slug}
        canManage={canManage}
        googleConfigured={isGoogleConfigured()}
        setting={{
          googleSheetId: setting?.googleSheetId ?? "",
          driveFolderId: setting?.driveFolderId ?? "",
          autoJson: setting?.autoJson ?? false,
          lastJsonAt: setting?.lastJsonAt?.toISOString().slice(0, 16).replace("T", " ") ?? null,
          lastSheetsAt: setting?.lastSheetsAt?.toISOString().slice(0, 16).replace("T", " ") ?? null,
        }}
        logs={logRows}
      />
      <PersonalBackupCard slug={slug} status={personal} />
    </div>
  );
}
