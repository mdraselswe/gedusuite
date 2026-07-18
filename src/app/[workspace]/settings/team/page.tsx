import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { revokeInvite } from "@/server/actions/team";
import { InviteForm } from "./invite-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { membership } = await requireMembership(slug);

  // Team/Settings is OWNER-only (TECH_SPEC section 5).
  if (!can(membership.role, "team", "full", undefined)) redirect(`/${slug}/dashboard`);

  const [members, invites] = await Promise.all([
    prisma.membership.findMany({
      where: { workspaceId: membership.workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invite.findMany({
      where: { workspaceId: membership.workspaceId, acceptedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="text-sm text-muted-foreground">
          Invite people and assign roles.
        </p>
      </div>

      <InviteForm slug={slug} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members ({members.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between text-sm">
              <div>
                <div className="font-medium">{m.user.name ?? m.user.email}</div>
                <div className="text-muted-foreground">{m.user.email}</div>
              </div>
              <span className="text-xs font-medium text-muted-foreground">{m.role}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invites</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-sm">
                <div>
                  <div className="font-medium">{inv.email}</div>
                  <div className="text-muted-foreground">{inv.role}</div>
                </div>
                <form action={revokeInvite}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="inviteId" value={inv.id} />
                  <Button variant="ghost" size="sm" type="submit">
                    Revoke
                  </Button>
                </form>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
