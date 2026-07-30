// One-off maintenance: re-sync _prisma_migrations checksums with the migration
// files on disk. Use when a migration file was edited after being applied and
// `prisma migrate dev` demands a reset. Touches ONLY the checksum column of
// already-applied rows — never schema or business data.
//
//   node scripts/fix-migration-checksums.mjs         # dry run (report only)
//   node scripts/fix-migration-checksums.mjs --fix   # write corrected checksums
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--fix");
const dir = join(process.cwd(), "prisma", "migrations");

const local = new Map();
for (const name of readdirSync(dir)) {
  if (name === "migration_lock.toml") continue;
  const sql = readFileSync(join(dir, name, "migration.sql"));
  local.set(name, createHash("sha256").update(sql).digest("hex"));
}

const rows = await prisma.$queryRawUnsafe(
  `SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY migration_name`,
);

let mismatches = 0;
for (const row of rows) {
  const fileHash = local.get(row.migration_name);
  if (!fileHash) {
    console.log(`DB-only (no local folder): ${row.migration_name}`);
    continue;
  }
  if (fileHash === row.checksum) continue;
  mismatches++;
  console.log(`MISMATCH ${row.migration_name}`);
  console.log(`  db:   ${row.checksum}`);
  console.log(`  file: ${fileHash}`);
  if (apply) {
    await prisma.$executeRawUnsafe(
      `UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2`,
      fileHash,
      row.migration_name,
    );
    console.log("  -> updated to file hash");
  }
}

for (const name of local.keys()) {
  if (!rows.some((r) => r.migration_name === name)) {
    console.log(`Local-only (not applied): ${name}`);
  }
}

console.log(mismatches === 0 ? "All checksums in sync." : `${mismatches} mismatch(es)${apply ? " fixed" : " (dry run — rerun with --fix)"}.`);
await prisma.$disconnect();
