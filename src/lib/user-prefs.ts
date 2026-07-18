import { cache } from "react";
import { prisma } from "@/lib/prisma";

/**
 * Cached per-request: root layout and the workspace layout both need this
 * user's theme/colorPreset/locale. Without `cache()` that's the same row
 * fetched twice (a full network round trip) on every single navigation.
 * React dedupes calls with identical args within one render pass.
 */
export const getUserPrefs = cache(async (userId: string) => {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { theme: true, colorPreset: true, locale: true },
  });
});
