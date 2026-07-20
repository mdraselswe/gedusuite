import { redirect } from "next/navigation";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { serverT } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { Palette } from "lucide-react";

export default async function AppearancePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { theme: true, colorPreset: true, locale: true },
  });

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader icon={<Palette />} color="fuchsia" title={(await serverT())("appearance")} />
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
