-- Shop address printed on order forms. Nullable: every existing workspace
-- genuinely has no website recorded, and the form simply omits the line.
ALTER TABLE "Workspace" ADD COLUMN "websiteUrl" TEXT;
