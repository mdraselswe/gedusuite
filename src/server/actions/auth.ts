"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { failed, type ActionFailure } from "@/lib/form";
import { actionMail, appUrl, sendMail } from "@/lib/mailer";
import { consumeToken, issueToken } from "@/lib/account-tokens";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { auth } from "@/lib/session";

const RegisterSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export type ActionResult = { ok: true } | ActionFailure;

async function callerIp(): Promise<string> {
  try {
    return clientIp(await headers());
  } catch {
    return "unknown";
  }
}

const tooMany = (secs: number): ActionFailure => ({
  ok: false,
  error: `Too many attempts. Please wait ${Math.max(1, Math.ceil(secs / 60))} minute(s) and try again.`,
});

async function sendVerificationEmail(user: { id: string; email: string; name: string | null }) {
  const token = await issueToken("verify-email", user.id);
  const mail = actionMail({
    to: user.email,
    subject: "Confirm your email for GeduSuite",
    heading: `Welcome${user.name ? `, ${user.name}` : ""}`,
    body: "Confirm your email address to finish setting up your GeduSuite account.",
    buttonLabel: "Confirm email",
    url: `${appUrl()}/verify-email/${token}`,
    footnote: "If you did not create this account, you can ignore this message.",
  });
  return sendMail(mail);
}

/** Create a credentials-based user account. Sign-in happens client-side after. */
export async function registerUser(formData: FormData): Promise<ActionResult> {
  const parsed = RegisterSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const { name, email, password } = parsed.data;

  // Per address and per client, so neither one inbox nor one machine can be
  // used to churn out accounts.
  const ip = await callerIp();
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`register:ip:${ip}`, 10, 3600),
    rateLimit(`register:email:${email}`, 5, 3600),
  ]);
  if (!byIp.allowed) return tooMany(byIp.retryAfterSec);
  if (!byEmail.allowed) return tooMany(byEmail.retryAfterSec);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: "An account with this email already exists" };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { name, email, passwordHash } });
  // Failure to send must not fail sign-up; the banner offers "resend".
  await sendVerificationEmail(user).catch(() => undefined);
  return { ok: true };
}

/** Re-send the confirmation link to the signed-in user. */
export async function resendVerificationEmail(): Promise<ActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Please sign in first" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
  if (!user) return { ok: false, error: "Account not found" };
  if (user.emailVerified) return { ok: true };

  const limited = await rateLimit(`verify-resend:${user.id}`, 3, 3600);
  if (!limited.allowed) return tooMany(limited.retryAfterSec);

  const sent = await sendVerificationEmail(user);
  if (!sent.ok) return { ok: false, error: "We could not send the email. Please try again shortly." };
  return { ok: true };
}

/**
 * Start a password reset. Always answers "ok" whether or not the address has an
 * account, so this form cannot be used to find out who is registered.
 */
export async function requestPasswordReset(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!z.string().email().safeParse(email).success) {
    return { ok: false, error: "Enter a valid email" };
  }

  const ip = await callerIp();
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`reset:ip:${ip}`, 10, 3600),
    rateLimit(`reset:email:${email}`, 3, 3600),
  ]);
  // Over the limit looks identical to success from the outside.
  if (!byIp.allowed || !byEmail.allowed) return { ok: true };

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });
  if (user) {
    const token = await issueToken("reset-password", user.id);
    await sendMail(
      actionMail({
        to: user.email,
        subject: "Reset your GeduSuite password",
        heading: "Reset your password",
        body: "Someone asked to reset the password for this account. The link works once and expires in 30 minutes.",
        buttonLabel: "Choose a new password",
        url: `${appUrl()}/reset-password/${token}`,
        footnote: "If this was not you, ignore this email — your password has not changed.",
      }),
    ).catch(() => undefined);
  }
  return { ok: true };
}

const ResetSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

/** Finish a password reset with the emailed token. */
export async function resetPassword(formData: FormData): Promise<ActionResult> {
  const parsed = ResetSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) return failed(parsed.error);

  const ip = await callerIp();
  const limited = await rateLimit(`reset-apply:ip:${ip}`, 20, 3600);
  if (!limited.allowed) return tooMany(limited.retryAfterSec);

  const userId = await consumeToken("reset-password", parsed.data.token);
  if (!userId) {
    return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };
  }

  const now = new Date();
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await bcrypt.hash(parsed.data.password, 12),
      // They just proved they control the inbox.
      emailVerified: now,
      // Any session cookie issued before this moment stops working.
      sessionsValidAfter: now,
    },
  });
  return { ok: true };
}

/** Consume an email-verification link. Returns whether it worked. */
export async function verifyEmailToken(token: string): Promise<boolean> {
  const userId = await consumeToken("verify-email", token);
  if (!userId) return false;
  await prisma.user.updateMany({
    where: { id: userId, emailVerified: null },
    data: { emailVerified: new Date() },
  });
  return true;
}

/**
 * Delete the signed-in person's own account.
 *
 * Refused — with the reason named — while deleting it would orphan somebody
 * else's business: being the only owner of a workspace, or being a partner on
 * whose capital account other records depend. Both have a proper way out
 * (hand the workspace over or delete it; have an owner remove the partner
 * record), and a silent cascade through someone's accounts is not one.
 */
export async function deleteMyAccount(formData: FormData): Promise<ActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Please sign in first" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!user) return { ok: false, error: "Account not found" };
  if (String(formData.get("confirmEmail") ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return { ok: false, error: "Type your email address exactly to confirm" };
  }

  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { role: true, workspaceId: true, workspace: { select: { name: true } } },
  });
  const soleOwner: string[] = [];
  for (const m of memberships) {
    if (m.role !== "OWNER") continue;
    const owners = await prisma.membership.count({
      where: { workspaceId: m.workspaceId, role: "OWNER" },
    });
    if (owners <= 1) soleOwner.push(m.workspace.name);
  }
  if (soleOwner.length > 0) {
    return {
      ok: false,
      error: `You are the only owner of ${soleOwner.join(", ")}. Make someone else an owner, or delete the workspace, first.`,
    };
  }

  const partnerOn = await prisma.partner.findMany({
    where: { userId },
    select: { workspace: { select: { name: true } } },
  });
  if (partnerOn.length > 0) {
    return {
      ok: false,
      error: `You are recorded as a partner in ${partnerOn
        .map((p) => p.workspace.name)
        .join(", ")}. Ask an owner to remove your partner record first — it holds capital and profit history.`,
    };
  }

  await prisma.user.delete({ where: { id: userId } });
  return { ok: true };
}
