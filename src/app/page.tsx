import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { SignOutButton } from "@/components/sign-out-button";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function HomePage() {
  const user = await requireUser();
  // Display names come fresh from the DB — the JWT membership snapshot only
  // carries slugs, and names can be renamed at any time.
  const names = await prisma.workspace.findMany({
    where: { id: { in: user.memberships.map((m) => m.workspaceId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(names.map((w) => [w.id, w.name]));
  const workspaces = user.memberships;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">GeduSuite</h1>
          <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
        </div>
        <SignOutButton />
      </header>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your workspaces</h2>
        <Link href="/workspaces/new" className={buttonVariants({ size: "sm" })}>
          + New workspace
        </Link>
      </div>

      {workspaces.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            You’re not part of any workspace yet.
            <div className="mt-4">
              <Link href="/workspaces/new" className={buttonVariants()}>
                Create your first workspace
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {workspaces.map((w) => (
            <li key={w.workspaceId}>
              <Link href={`/${w.slug}/dashboard`}>
                <Card className="transition-colors hover:bg-accent">
                  <CardHeader className="flex-row items-center justify-between">
                    <div className="min-w-0">
                      <CardTitle className="text-base">
                        {nameById.get(w.workspaceId) ?? w.slug}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">/{w.slug}</p>
                    </div>
                    <span className="text-xs font-medium text-muted-foreground">
                      {w.role}
                    </span>
                  </CardHeader>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
