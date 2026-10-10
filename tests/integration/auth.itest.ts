import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { clearOutbox, outbox } from "@/lib/mailer";
import { issueToken, consumeToken } from "@/lib/account-tokens";
import { rateLimit } from "@/lib/rate-limit";
import {
  registerUser,
  requestPasswordReset,
  resetPassword,
  verifyEmailToken,
} from "@/server/actions/auth";
import { createWorkspace } from "@/server/actions/workspace";
import { createOrder } from "@/server/actions/orders";
import { actAs, createUser, createWorkspaceWithOwner, fd, resetDatabase } from "./harness";

type Authorize = (
  c: Record<string, string>,
  req?: { headers: Record<string, string> },
) => Promise<{ id: string } | null>;

const authorize: Authorize = (
  authOptions.providers.find((p) => p.id === "credentials") as unknown as {
    options: { authorize: Authorize };
  }
).options.authorize;

const signInCb = authOptions.callbacks!.signIn!;

function tokenFromOutbox(path: string): string {
  const mail = outbox().at(-1)!;
  const m = mail.text.match(new RegExp(`/${path}/([A-Za-z0-9_-]+)`));
  if (!m) throw new Error(`no ${path} link in mail:\n${mail.text}`);
  return m[1];
}

beforeAll(async () => {
  await resetDatabase();
});
beforeEach(() => {
  clearOutbox();
  (globalThis as { __testIp?: string }).__testIp = `198.51.100.${Math.floor(Math.random() * 200)}`;
});

describe("sign-up and email confirmation", () => {
  it("creates an unverified account and mails a confirmation link", async () => {
    const res = await registerUser(
      fd({ name: "New Person", email: "New@Example.com", password: "longenough1" }),
    );
    expect(res.ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "new@example.com" } });
    expect(u.emailVerified).toBeNull();
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0].to).toBe("new@example.com");

    const token = tokenFromOutbox("verify-email");
    expect(await verifyEmailToken(token)).toBe(true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerified,
    ).not.toBeNull();
    // single use
    expect(await verifyEmailToken(token)).toBe(false);
  });

  it("an unverified account cannot create a workspace; a verified one can", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "new@example.com" } });
    await prisma.user.update({ where: { id: u.id }, data: { emailVerified: null } });
    await actAs(u.id);
    const blocked = await createWorkspace(fd({ name: "Blocked Shop" }));
    expect(blocked.ok).toBe(false);
    await prisma.user.update({ where: { id: u.id }, data: { emailVerified: new Date() } });
    const ok = await createWorkspace(fd({ name: "Allowed Shop" }));
    expect(ok.ok).toBe(true);
  });

  it("tokens are purpose-bound and expire", async () => {
    const u = await createUser("tok@example.com", "Tok");
    const t = await issueToken("verify-email", u.id);
    expect(await consumeToken("reset-password", t)).toBeNull(); // wrong purpose
    const t2 = await issueToken("reset-password", u.id);
    await prisma.verificationToken.updateMany({ data: { expires: new Date(Date.now() - 1000) } });
    expect(await consumeToken("reset-password", t2)).toBeNull(); // expired
  });
});

describe("password reset", () => {
  it("does not reveal whether an address has an account", async () => {
    const a = await requestPasswordReset(fd({ email: "nobody@example.com" }));
    expect(a.ok).toBe(true);
    expect(outbox()).toHaveLength(0);
  });

  it("resets the password, verifies the address, and voids older sessions", async () => {
    const u = await createUser("reset@example.com", "Reset Me", "old-password-1");
    await prisma.user.update({ where: { id: u.id }, data: { emailVerified: null } });
    await createWorkspaceWithOwner("Reset Shop", "reset-shop", u.id);

    expect((await requestPasswordReset(fd({ email: "reset@example.com" }))).ok).toBe(true);
    const token = tokenFromOutbox("reset-password");

    // A cookie issued BEFORE the reset...
    const issuedBefore = Math.floor(Date.now() / 1000) - 600;
    const res = await resetPassword(fd({ token, password: "brand-new-pw-2" }));
    expect(res.ok).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await bcrypt.compare("brand-new-pw-2", after.passwordHash!)).toBe(true);
    expect(after.emailVerified).not.toBeNull();
    expect(after.sessionsValidAfter).not.toBeNull();

    // ...no longer reaches workspace actions.
    await actAs(u.id, { issuedAt: issuedBefore });
    const denied = await createOrder(
      "reset-shop",
      fd({
        date: "2026-09-01",
        status: "CONFIRMED",
        deliveryType: "SELF",
        paymentMethod: "CASH",
        paymentStatus: "UNPAID",
        items: [],
      }),
    );
    expect(denied).toMatchObject({ ok: false, error: "Workspace not found or access denied" });

    // token is single-use
    expect((await resetPassword(fd({ token, password: "another-pw-3" }))).ok).toBe(false);
  });
});

describe("sign-in throttling", () => {
  it("locks guessing after repeated failures, and a right password clears the counter", async () => {
    await createUser("guess@example.com", "Guess", "correct-horse-1");
    const req = { headers: { "x-forwarded-for": "192.0.2.55" } };

    for (let i = 0; i < 4; i++) {
      expect(await authorize({ email: "guess@example.com", password: "wrong" }, req)).toBeNull();
    }
    // still allowed to succeed within the limit — and it resets the counter
    expect(
      await authorize({ email: "guess@example.com", password: "correct-horse-1" }, req),
    ).not.toBeNull();

    for (let i = 0; i < 10; i++) {
      await authorize({ email: "guess@example.com", password: "wrong" }, req);
    }
    // 11th try: even the right password is refused during the lockout
    expect(
      await authorize({ email: "guess@example.com", password: "correct-horse-1" }, req),
    ).toBeNull();
  });

  it("rateLimit is a window: counts, then resets", async () => {
    const k = `t:${Math.random()}`;
    expect((await rateLimit(k, 2, 60)).allowed).toBe(true);
    expect((await rateLimit(k, 2, 60)).allowed).toBe(true);
    expect((await rateLimit(k, 2, 60)).allowed).toBe(false);
    await prisma.rateLimit.update({ where: { key: k }, data: { resetAt: new Date(Date.now() - 1000) } });
    expect((await rateLimit(k, 2, 60)).allowed).toBe(true);
  });
});

describe("pre-hijack protection on Google linking", () => {
  it("removes an unverified account's password when the real owner signs in with Google", async () => {
    // An attacker registered the victim's address with a password they know.
    const attacker = await prisma.user.create({
      data: {
        email: "victim@example.com",
        name: "Mallory",
        passwordHash: await bcrypt.hash("attacker-pw-1", 4),
      },
    });
    const ok = await signInCb({
      user: { id: "x" },
      account: { provider: "google", type: "oauth", providerAccountId: "g-1" },
      profile: { email: "victim@example.com", email_verified: true },
    } as never);
    expect(ok).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: attacker.id } });
    expect(after.passwordHash).toBeNull();
    expect(after.emailVerified).not.toBeNull();
    // the attacker's password is dead
    expect(await authorize({ email: "victim@example.com", password: "attacker-pw-1" })).toBeNull();
  });

  it("leaves a verified account's password alone", async () => {
    const u = await createUser("legit@example.com", "Legit", "legit-pw-12345");
    await signInCb({
      user: { id: "x" },
      account: { provider: "google", type: "oauth", providerAccountId: "g-2" },
      profile: { email: "legit@example.com", email_verified: true },
    } as never);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.passwordHash).not.toBeNull();
  });

  it("refuses a Google profile whose email Google did not verify", async () => {
    const ok = await signInCb({
      user: { id: "x" },
      account: { provider: "google", type: "oauth", providerAccountId: "g-3" },
      profile: { email: "x@example.com", email_verified: false },
    } as never);
    expect(ok).toBe(false);
  });
});
