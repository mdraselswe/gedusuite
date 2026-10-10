"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { workspaceAccess } from "@/lib/authz";
import { failed, type ActionFailure } from "@/lib/form";
import { sendMail } from "@/lib/mailer";
import { platformAdminEmails } from "@/lib/platform-admin";
import { rateLimit } from "@/lib/rate-limit";

export type ActionResult = { ok: true } | ActionFailure;

const Schema = z.object({
  subject: z.string().trim().min(3, "Say what it is about").max(120),
  message: z.string().trim().min(10, "Tell us a little more").max(4000),
});

/** Where support messages go: the support inbox, else the first platform admin. */
function supportInbox(): string | null {
  return process.env.BILLING_SUPPORT_EMAIL || platformAdminEmails()[0] || null;
}

/**
 * A message from a signed-in member to whoever runs the platform.
 *
 * Sent as email with the workspace and sender spelled out, so the reply has
 * context without asking for it. Not stored: an inbox is the right place for
 * a conversation, and a table of tickets is a product of its own.
 */
export async function sendSupportMessage(slug: string, formData: FormData): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Workspace not found or access denied" };

  const parsed = Schema.safeParse({
    subject: formData.get("subject"),
    message: formData.get("message"),
  });
  if (!parsed.success) return failed(parsed.error);

  const pace = await rateLimit(`support:${access.userId}`, 5, 3600);
  if (!pace.allowed) {
    return { ok: false, error: "You have sent several messages in the last hour. Please wait a little." };
  }

  const inbox = supportInbox();
  if (!inbox) {
    return { ok: false, error: "Support is not set up on this installation yet." };
  }

  const [user, ws] = await Promise.all([
    prisma.user.findUnique({
      where: { id: access.userId },
      select: { name: true, email: true },
    }),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, slug: true },
    }),
  ]);

  const d = parsed.data;
  const sent = await sendMail({
    to: inbox,
    subject: `[GeduSuite support] ${d.subject}`,
    text:
      `From: ${user?.name ?? "(no name)"} <${user?.email}>\n` +
      `Workspace: ${ws?.name} (/${ws?.slug})\n` +
      `Role: ${access.role}\n\n${d.message}`,
  });
  if (!sent.ok) return { ok: false, error: "We could not send that. Please try again shortly." };
  return { ok: true };
}
