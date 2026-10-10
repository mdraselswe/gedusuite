import { prisma } from "@/lib/prisma";

function base(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

/**
 * Top-level paths that belong to the app itself. A workspace lives at
 * /<slug>/..., so a workspace called "Admin" would otherwise shadow /admin.
 */
const RESERVED = new Set([
  "admin", "api", "login", "register", "invite", "workspaces", "offline",
  "forgot-password", "reset-password", "verify-email", "pricing", "terms",
  "privacy", "refund", "about", "contact", "help", "support", "billing",
  "signup", "signin", "logout", "app", "www", "status", "docs", "blog",
  "_next", "icons", "fonts", "branding", "favicon.ico", "manifest.webmanifest",
  "sw.js",
]);

/** Generate a workspace slug unique across all workspaces. */
export async function uniqueWorkspaceSlug(name: string): Promise<string> {
  const root = base(name);
  let slug = root;
  let n = 1;
  while (RESERVED.has(slug) || (await prisma.workspace.findUnique({ where: { slug } }))) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}
