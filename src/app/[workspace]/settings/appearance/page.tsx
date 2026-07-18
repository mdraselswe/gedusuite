import { redirect } from "next/navigation";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { serverT } from "@/lib/session";

export default async function AppearancePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { theme: true, colorPreset: true, locale: true },
  });

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-bold">{(await serverT())("appearance")}</h1>
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
