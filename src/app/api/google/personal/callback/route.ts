import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { exchangeCode } from "@/lib/google-personal";
import { encrypt } from "@/lib/crypto";

// OAuth callback — stores the user's encrypted tokens, then returns to Settings.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(new URL("/login", req.url));

  const code = req.nextUrl.searchParams.get("code");
  const stateRaw = req.nextUrl.searchParams.get("state");
  let slug = "";
  let uid = "";
  try {
    const parsed = JSON.parse(Buffer.from(stateRaw ?? "", "base64url").toString());
    slug = parsed.slug ?? "";
    uid = parsed.uid ?? "";
  } catch {
    /* ignore */
  }

  const back = slug ? `/${slug}/settings/backup` : "/";
  // CSRF: the state's user must match the session user.
  if (!code || uid !== session.user.id) {
    return NextResponse.redirect(new URL(`${back}?personal=error`, req.url));
  }

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.access_token) throw new Error("No access token returned");
    await prisma.userGoogleConnection.upsert({
      where: { userId: session.user.id },
      create: {
        userId: session.user.id,
        accessToken: encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
      },
      update: {
        accessToken: encrypt(tokens.access_token),
        ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
        expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
        connectedAt: new Date(),
      },
    });
    return NextResponse.redirect(new URL(`${back}?personal=connected`, req.url));
  } catch {
    return NextResponse.redirect(new URL(`${back}?personal=error`, req.url));
  }
}
