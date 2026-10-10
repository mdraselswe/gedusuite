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

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-for":
        (globalThis as { __testIp?: string }).__testIp ?? "203.0.113.7",
    }),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

// ── Session: whoever the test says is acting ──────────────────────────
// Server actions read the session through getServerSession; tests set it with
// actAs() in harness.ts.
vi.mock("next-auth", () => ({
  getServerSession: async () =>
    (globalThis as { __testSession?: unknown }).__testSession ?? null,
  default: () => undefined,
}));
