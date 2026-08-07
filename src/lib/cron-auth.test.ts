import { describe, expect, it, afterEach } from "vitest";
import { denyCron } from "@/lib/cron-auth";

/** Just enough of a NextRequest for the guard, which only reads a header. */
const req = (auth?: string) =>
  ({ headers: { get: (k: string) => (k === "authorization" ? (auth ?? null) : null) } }) as never;

const original = process.env.CRON_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
});

describe("denyCron", () => {
  it("refuses everything when no secret is configured", async () => {
    // The old check was `if (secret) { ...verify... }`, so an unset variable
    // verified nothing and let the whole internet trigger backups. Unset is
    // exactly the state a deployment is in when nobody set it — and the README
    // asked for the wrong variable name, so that was the likely state here.
    delete process.env.CRON_SECRET;
    const res = denyCron(req("Bearer anything"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it("refuses a wrong or missing secret", () => {
    process.env.CRON_SECRET = "right";
    expect(denyCron(req("Bearer wrong"))!.status).toBe(401);
    expect(denyCron(req())!.status).toBe(401);
    // A prefix must not pass — length is checked before the comparison.
    expect(denyCron(req("Bearer righ"))!.status).toBe(401);
  });

  it("lets the real thing through", () => {
    process.env.CRON_SECRET = "right";
    expect(denyCron(req("Bearer right"))).toBeNull();
  });
});
