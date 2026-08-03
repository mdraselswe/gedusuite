import { spawnSync } from "node:child_process";

/**
 * Vercel runs `vercel-build` in preference to `build` when both exist, so the
 * `prisma migrate deploy` that lives in `build` never ran on a deploy. Every
 * schema change had to be applied by hand first, and a deploy that got ahead
 * of its migration shipped code querying a column the database didn't have —
 * a 500 on the affected page until somebody noticed.
 *
 * Migrating before generating also means the client is built against a
 * database that already matches the schema it came from.
 */

// Preview builds don't carry a DATABASE_URL of their own; migrating from one
// would target whatever that happened to resolve to. Skipping is right for a
// preview, and testing for the variables rather than VERCEL_ENV means giving
// previews their own database later just works.
const canMigrate = Boolean(process.env.DATABASE_URL && process.env.DIRECT_URL);

if (!canMigrate) {
  console.log("[vercel-build] DATABASE_URL/DIRECT_URL not set — skipping prisma migrate deploy");
}

const steps = [
  ...(canMigrate ? [["npx", ["prisma", "migrate", "deploy"]]] : []),
  ["npx", ["prisma", "generate"]],
  ["npx", ["next", "build", "--webpack"]],
];

for (const [command, args] of steps) {
  console.log(`[vercel-build] ${command} ${args.join(" ")}`);
  // shell: true so `npx` resolves on Windows too — otherwise this script can
  // only ever be run on the CI box it was written for, and a change to it
  // can't be tried out before it ships.
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.error) {
    // Without this a spawn failure exits 1 printing nothing at all, which
    // reads in the deploy log as "the build died for no reason".
    console.error(`[vercel-build] could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    // A failed migration has to stop the deploy. Building anyway would ship
    // exactly the mismatch this script exists to prevent.
    console.error(`[vercel-build] ${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
