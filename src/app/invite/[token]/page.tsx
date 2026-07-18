import { redirect } from "next/navigation";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { AcceptInvite } from "./accept-invite";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/invite/${token}`);
  }

  const invite = await prisma.invite.findUnique({
    where: { token },
    include: { workspace: { select: { name: true } } },
  });

  const invalid = !invite || invite.acceptedAt;
  const emailMismatch =
    invite &&
    invite.email.toLowerCase() !== (session.user.email ?? "").toLowerCase();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Workspace invitation</CardTitle>
          <CardDescription>
            {invalid
              ? "This invite is invalid or has already been used."
              : `You’ve been invited to join ${invite!.workspace.name} as ${invite!.role}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invalid ? null : emailMismatch ? (
            <p className="text-sm text-muted-foreground">
              This invite is for <span className="font-medium">{invite!.email}</span>. Sign
              in with that email to accept.
            </p>
          ) : (
            <AcceptInvite token={token} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
