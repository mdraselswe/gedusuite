import { defineConfig } from "vitest/config";
import { loadEnvFile } from "node:process";

/**
 * Integration tests: the real server actions and finance code against the
 * LOCAL Postgres (yarn db:local + yarn local:migrate). Never against Neon —
 * tests/integration/setup.ts refuses any non-local DATABASE_URL.
 */
try {
  loadEnvFile(".env.saas.local");
} catch {
  /* env may be provided by the shell */
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.itest.ts", "scripts/demo/**/*.seed.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    // One database, so one file at a time, and tests inside a file in order.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
