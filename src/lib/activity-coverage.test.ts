import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The audit trail is written by hand, one call per action, which means it can
 * be forgotten — and a history with a silent hole in it is worse than no
 * history, because it reads as "nobody changed that".
 *
 * So this is the guard: a file that writes to the database has to say who did
 * it. Not a proof that every branch logs, but it catches the whole class of
 * "added a new action, forgot the history", which is the way this actually
 * goes wrong.
 *
 * A file with a real reason not to log goes in EXEMPT, with the reason. That
 * list is meant to be short and argued over, not grown quietly.
 */

const ACTIONS_DIR = join(process.cwd(), "src", "server", "actions");

const EXEMPT: Record<string, string> = {
  "auth.ts": "Registration happens before any workspace exists to log against.",
  "notifications.ts":
    "Marking an alert read is not a change to the business's data — logging it would bury the entries that are.",
  "preferences.ts": "Theme and language are one user's own display settings.",
  "search.ts": "Reads only.",
  "backup.ts":
    "Backups write BackupLog, which is already the record of who ran what and when.",
  "personal-backup.ts":
    "Connecting a personal Google account writes only that user's own token.",
  "workspace.ts":
    "Creating a workspace happens before there is a workspace to hold the entry.",
  "leads.ts":
    "Call outcomes churn many times per lead per day; the order created from a lead is logged where it lands.",
};

const WRITE_CALL = /\b(?:prisma|tx)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;

describe("audit trail coverage", () => {
  const files = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"));

  it("finds the action files at all", () => {
    // Guards against the test quietly passing because the path moved.
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
    const writes = WRITE_CALL.test(source);
    if (!writes) continue;

    it(`${file} records who changed what`, () => {
      if (EXEMPT[file]) {
        expect(EXEMPT[file].length).toBeGreaterThan(20);
        return;
      }
      expect(
        source.includes("recordActivity") || source.includes("recordSystemActivity"),
        `${file} writes to the database but never records an activity entry. ` +
          `Add recordActivity(gate.access, …) after the write commits, or add ` +
          `${file} to EXEMPT with the reason.`,
      ).toBe(true);
    });
  }
});
