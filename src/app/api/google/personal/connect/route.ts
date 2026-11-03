import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/session";
import { consentUrl, personalBackupConfigured } from "@/lib/google-personal";

// Kicks off the Google consent flow: the per-user personal backup, or with
// ?purpose=reseller the shop's account that holds the reseller price sheet.
// Both come back through the one callback, which is the redirect URI already
// registered with Google.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (!personalBackupConfigured()) {
    return NextResponse.json({ error: "Google OAuth is not configured" }, { status: 400 });
  }
  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  const purpose = req.nextUrl.searchParams.get("purpose") === "reseller" ? "reseller" : undefined;
  const state = Buffer.from(JSON.stringify({ uid: session.user.id, slug, purpose })).toString("base64url");
  return NextResponse.redirect(consentUrl(state));
}
