import { vi } from "vitest";
import { assertSafeDatabaseUrl } from "../../scripts/dev/assert-safe-db.mjs";

// Hard stop before anything can touch a remote database.
assertSafeDatabaseUrl(process.env.DATABASE_URL);

// ── Next.js runtime shims ─────────────────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

// ── Session: whoever the test says is acting ──────────────────────────
// Server actions read the session through getServerSession; tests set it with
// actAs() in harness.ts.
vi.mock("next-auth", () => ({
  getServerSession: async () =>
    (globalThis as { __testSession?: unknown }).__testSession ?? null,
  default: () => undefined,
}));
