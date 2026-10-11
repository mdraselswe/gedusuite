import { redirect } from "next/navigation";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { workspaceAccess } from "@/lib/authz";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { DeleteAccountCard } from "@/components/settings/delete-account";
import { PrintProfileForm } from "@/components/settings/print-profile-form";
import { parsePrintProfile } from "@/lib/print-profile";
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
      select: { theme: true, colorPreset: true, locale: true, email: true },
    }),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true, websiteUrl: true, printProfile: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader icon={<Palette />} color="fuchsia" title={(await serverT())("appearance")} />
      {access.role === "OWNER" && (
        <BrandingForm
          slug={slug}
          initialName={workspace?.name ?? ""}
          initialLogoUrl={workspace?.logoUrl ?? null}
          initialWebsiteUrl={workspace?.websiteUrl ?? null}
        />
      )}
      {access.role === "OWNER" && (
        <PrintProfileForm
          slug={slug}
          initial={parsePrintProfile(workspace?.printProfile)}
          websiteUrl={workspace?.websiteUrl ?? null}
        />
      )}
      <AppearanceForm
        initial={{
          theme: user?.theme ?? "system",
          colorPreset: user?.colorPreset ?? "indigo",
          locale: (user?.locale as "en" | "bn") ?? "en",
        }}
      />
      {user?.email ? <DeleteAccountCard email={user.email} /> : null}
    </div>
  );
}
