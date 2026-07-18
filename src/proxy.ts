import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { moduleForSegment, can } from "@/lib/rbac";
import type { SessionMembership } from "@/lib/auth";

// Paths that never require auth or workspace scoping.
const PUBLIC_PREFIXES = ["/login", "/register", "/invite", "/api/auth"];
// Top-level app routes that need auth but aren't workspace-scoped.
const NON_WORKSPACE = new Set(["", "workspaces", "api"]);

export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  // Unauthenticated → send to login, preserving intended destination.
  if (!token?.uid) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0] ?? "";

  // Non-workspace authed routes ("/", "/workspaces/new") — just require login.
  if (NON_WORKSPACE.has(first)) return NextResponse.next();

  // Workspace-scoped route: /[slug]/[module]/...
  const slug = first;
  const memberships = (token.memberships as SessionMembership[] | undefined) ?? [];
  const membership = memberships.find((m) => m.slug === slug);

  // Not a member of this workspace → bounce to workspace picker.
  if (!membership) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Enforce module-level access from the RBAC matrix.
  const moduleSegment = segments[1];
  if (moduleSegment) {
    const mod = moduleForSegment(moduleSegment);
    if (mod && !can(membership.role, mod, "view")) {
      const url = req.nextUrl.clone();
      url.pathname = `/${slug}/dashboard`;
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals and static/PWA assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)",
  ],
};
