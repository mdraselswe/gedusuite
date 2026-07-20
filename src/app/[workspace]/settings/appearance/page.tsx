import { redirect } from "next/navigation";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { workspaceAccess } from "@/lib/authz";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { BrandingForm } from "@/components/settings/branding-form";
import { serverT } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { Palette } from "lucide-react";

export default async function AppearancePage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const access = await workspaceAccess(slug);
  if (!access) redirect("/");

  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { theme: true, colorPreset: true, locale: true },
    }),
    prisma.workspace.findUnique({ where: { id: access.workspaceId }, select: { logoUrl: true } }),
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader icon={<Palette />} color="fuchsia" title={(await serverT())("appearance")} />
      {access.role === "OWNER" && (
        <BrandingForm slug={slug} initialLogoUrl={workspace?.logoUrl ?? null} />
      )}
      <AppearanceForm
        initial={{
          theme: user?.theme ?? "system",
          colorPreset: user?.colorPreset ?? "indigo",
          locale: (user?.locale as "en" | "bn") ?? "en",
        }}
      />
    </div>
  );
}
