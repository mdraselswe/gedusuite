-- CreateEnum
CREATE TYPE "GoogleScope" AS ENUM ('PERSONAL_BACKUP');

-- CreateTable
CREATE TABLE "UserGoogleConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "GoogleScope" NOT NULL DEFAULT 'PERSONAL_BACKUP',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiryDate" BIGINT,
    "sheetId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "UserGoogleConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserGoogleConnection_userId_key" ON "UserGoogleConnection"("userId");

-- AddForeignKey
ALTER TABLE "UserGoogleConnection" ADD CONSTRAINT "UserGoogleConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
