import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { BackupManager } from "@/components/backup/backup-manager";
import { PersonalBackupCard } from "@/components/backup/personal-backup-card";
import { getPersonalStatus } from "@/server/actions/personal-backup";
import { serverT } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { DatabaseBackup } from "lucide-react";

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
      take: 200, // client-side pagination in the table handles the rest
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
    <div className="space-y-6">
      <PageHeader icon={<DatabaseBackup />} color="rose" title={(await serverT())("backupRecovery")} />
      <BackupManager
        slug={slug}
        canManage={canManage}
        setting={{
          lastJsonAt: setting?.lastJsonAt?.toISOString().slice(0, 16).replace("T", " ") ?? null,
        }}
        logs={logRows}
      />
      <PersonalBackupCard slug={slug} status={personal} />
    </div>
  );
}
