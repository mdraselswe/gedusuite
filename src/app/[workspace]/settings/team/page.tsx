import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { revokeInvite } from "@/server/actions/team";
import { InviteForm } from "./invite-form";
import { MemberList } from "./member-list";
import { serverT } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { UserCog } from "lucide-react";

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
        <PageHeader icon={<UserCog />} color="slate" title={(await serverT())("team")} />
        <p className="text-sm text-muted-foreground">
          Invite people and assign roles.
        </p>
      </div>

      <InviteForm slug={slug} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <MemberList
            slug={slug}
            members={members.map((m) => ({
              id: m.id,
              role: m.role,
              name: m.user.name ?? m.user.email,
              email: m.user.email,
            }))}
          />
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
