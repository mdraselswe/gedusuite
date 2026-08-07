"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { failed, type ActionFailure } from "@/lib/form";

export type ActionResult = { ok: true } | ActionFailure;

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
    return failed(parsed.error);
  }
  await prisma.user.update({ where: { id: user.id }, data: parsed.data });
  return { ok: true };
}
