-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('SHEETS', 'JSON');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('IN_PROGRESS', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "BackupLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "BackupType" NOT NULL,
    "status" "BackupStatus" NOT NULL,
    "triggeredBy" TEXT,
    "fileUrl" TEXT,
    "payload" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "googleSheetId" TEXT,
    "driveFolderId" TEXT,
    "autoJson" BOOLEAN NOT NULL DEFAULT false,
    "lastJsonAt" TIMESTAMP(3),
    "lastSheetsAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupLog_workspaceId_idx" ON "BackupLog"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BackupSetting_workspaceId_key" ON "BackupSetting"("workspaceId");

-- AddForeignKey
ALTER TABLE "BackupLog" ADD CONSTRAINT "BackupLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupSetting" ADD CONSTRAINT "BackupSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
