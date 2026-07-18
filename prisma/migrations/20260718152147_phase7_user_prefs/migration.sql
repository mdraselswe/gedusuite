-- AlterTable
ALTER TABLE "User" ADD COLUMN     "colorPreset" TEXT NOT NULL DEFAULT 'indigo',
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "theme" TEXT NOT NULL DEFAULT 'system';
