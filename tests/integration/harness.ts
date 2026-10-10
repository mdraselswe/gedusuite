import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";

/** Everything a test needs to say "this person is doing it now". */
export async function actAs(userId: string | null) {
  const g = globalThis as { __testSession?: unknown };
  if (!userId) {
    g.__testSession = null;
    return;
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, locale: true },
  });
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { workspaceId: true, role: true, workspace: { select: { slug: true } } },
  });
  g.__testSession = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      locale: user.locale,
      memberships: memberships.map((m) => ({
        workspaceId: m.workspaceId,
        slug: m.workspace.slug,
        role: m.role,
      })),
    },
  };
}

/** Build a FormData from a plain object (arrays/objects are JSON-encoded). */
export function fd(fields: Record<string, unknown>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    f.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return f;
}

export async function createUser(email: string, name: string, password = "Passw0rd!test") {
  return prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, 4), // cheap rounds: tests only
      emailVerified: new Date(),
    },
  });
}

export async function createWorkspaceWithOwner(name: string, slug: string, ownerId: string) {
  return prisma.workspace.create({
    data: {
      name,
      slug,
      memberships: { create: { userId: ownerId, role: "OWNER" } },
    },
  });
}

export async function addMember(workspaceId: string, userId: string, role: Role) {
  return prisma.membership.create({ data: { workspaceId, userId, role } });
}

/** Remove everything. Only ever runs against the local database. */
export async function resetDatabase() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename::text AS tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
