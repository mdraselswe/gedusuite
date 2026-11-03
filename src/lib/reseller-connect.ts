import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { encrypt } from "@/lib/crypto";
import { exchangeCode } from "@/lib/google-personal";
import { recordActivity } from "@/lib/activity";
import { googleAccountEmail } from "@/lib/reseller-sheet";
import { resellerGoogleClient } from "@/lib/reseller-sync";

/**
 * Store the Google account the reseller sheet will live in. Called from the
 * OAuth callback, so the same gate as the reseller page's actions applies.
 *
 * A different account from last time means the old sheet is out of reach
 * (drive.file only sees files this app made in *that* Drive), so the link to it
 * is dropped and the next sync makes a fresh one.
 */
export async function connectResellerGoogle(
  slug: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await requireAccess(slug, "products", "edit");
  if (!g.ok) return g;
  if (!can(g.access.role, "reports", "view", g.access.permissions)) {
    return { ok: false, error: "You do not have permission to do that" };
  }
  const workspaceId = g.access.workspaceId;

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.access_token) return { ok: false, error: "Google returned no access token" };
    const enc = {
      googleAccessToken: encrypt(tokens.access_token),
      googleRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      googleExpiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
    };
    const client = resellerGoogleClient(enc)!;
    const email = await googleAccountEmail(client);

    const before = await prisma.resellerPriceList.findUnique({ where: { workspaceId } });
    const sameAccount = !!before?.googleEmail && before.googleEmail === email;
    const saved = await prisma.resellerPriceList.upsert({
      where: { workspaceId },
      create: { workspaceId, googleEmail: email, ...enc },
      update: {
        googleEmail: email,
        ...enc,
        // A refresh token is only sent on first consent; keep the old one if
        // Google didn't send a new one for the same account.
        ...(!tokens.refresh_token && sameAccount ? { googleRefreshToken: before!.googleRefreshToken } : {}),
        ...(sameAccount ? {} : { sheetId: null }),
        lastSyncError: null,
        syncLockedUntil: null,
      },
    });
    await recordActivity(g.access, {
      action: "UPDATE",
      entity: "ResellerPriceList",
      entityId: saved.id,
      summary: `Google account ${email ?? ""} connected for the reseller sheet`.replace("  ", " "),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Google sign-in failed" };
  }
}
