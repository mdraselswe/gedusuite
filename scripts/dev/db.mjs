// Local, throwaway Postgres for SaaS-upgrade work.
//
//   node scripts/dev/db.mjs start   # runs in the foreground; Ctrl+C stops it
//
// Never points at Neon. Data lives in .local-db/ (gitignored). Wipe that folder
// to start from scratch.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.LOCAL_DB_PORT ?? 54329);
const DIR = resolve(process.cwd(), ".local-db");
const DB = "gedusuite";

const pg = new EmbeddedPostgres({
  databaseDir: DIR,
  user: "postgres",
  password: "postgres",
  port: PORT,
  persistent: true,
  // Windows defaults the cluster to WIN1252, which rejects the taka sign and
  // every Bangla customer name. Production is UTF8; so is this.
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
  onLog: () => {},
  onError: (e) => console.error("[pg]", String(e).trim()),
});

const fresh = !existsSync(resolve(DIR, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(DB);

console.log(`[local-db] ready: postgresql://postgres:postgres@localhost:${PORT}/${DB}`);

const stop = async () => {
  console.log("[local-db] stopping...");
  await pg.stop();
  process.exit(0);
};
process.on("exit", (c) => console.error(`[local-db] process exiting, code ${c}`));
process.on("uncaughtException", (e) => console.error("[local-db] uncaught", e));
process.on("unhandledRejection", (e) => console.error("[local-db] unhandled", e));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
