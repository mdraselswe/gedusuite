import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/session";
import { consentUrl, personalBackupConfigured } from "@/lib/google-personal";

// Kicks off the per-user personal-backup OAuth consent flow.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (!personalBackupConfigured()) {
    return NextResponse.json({ error: "Google OAuth is not configured" }, { status: 400 });
  }
  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  const state = Buffer.from(JSON.stringify({ uid: session.user.id, slug })).toString("base64url");
  return NextResponse.redirect(consentUrl(state));
}
