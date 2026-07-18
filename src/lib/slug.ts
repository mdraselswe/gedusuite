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

/** Generate a workspace slug unique across all workspaces. */
export async function uniqueWorkspaceSlug(name: string): Promise<string> {
  const root = base(name);
  let slug = root;
  let n = 1;
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}
