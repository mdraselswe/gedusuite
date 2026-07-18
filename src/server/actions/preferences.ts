"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export type ActionResult = { ok: true } | { ok: false; error: string };

const Schema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  colorPreset: z.enum(["indigo", "green", "rose", "amber"]),
  locale: z.enum(["en", "bn"]),
});

export async function updatePreferences(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = Schema.safeParse({
    theme: formData.get("theme"),
    colorPreset: formData.get("colorPreset"),
    locale: formData.get("locale"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await prisma.user.update({ where: { id: user.id }, data: parsed.data });
  return { ok: true };
}
