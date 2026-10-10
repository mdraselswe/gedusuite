// Refuse to run destructive tooling (seed, golden master, e2e) against anything
// that looks like the production database.
//
// Allowed: localhost / 127.0.0.1 / [::1].
// Everything else — and in particular any *.neon.tech host — is refused, so a
// wrong env file can never turn a test run into a production write.
export function assertSafeDatabaseUrl(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"];
  if (!local.includes(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is not local. ` +
        `Use .env.saas.local and the local database (yarn db:local).`,
    );
  }
}
