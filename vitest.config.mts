import { defineConfig } from "vitest/config";

/**
 * Unit tests for the money math only — the pure functions in src/lib that
 * decide what an order earned, what a courier keeps and what each partner is
 * owed. Nothing here touches the database or Next.js; anything that needs
 * either is tested by using the app.
 *
 * `.mts` so the config is loaded as ESM, and tsconfig paths resolved natively
 * rather than through a plugin — both are what Vite asks for.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
