// Clears the sign-in throttle counters in the LOCAL database, for when a demo
// login says "too many attempts".
import pg from "pg";
import { assertSafeDatabaseUrl } from "./assert-safe-db.mjs";

assertSafeDatabaseUrl();
const c = new pg.Client(process.env.DATABASE_URL);
await c.connect();
const r = await c.query('DELETE FROM "RateLimit"');
console.log(`cleared ${r.rowCount} throttle counter(s)`);
await c.end();
