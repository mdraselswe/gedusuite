import { redirect } from "next/navigation";
import { Globe } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/page-header";
import { WebsiteConnection } from "@/components/settings/website-connection";
import { getWebsiteIntegration } from "@/server/actions/integrations";

export default async function WebsiteSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  // Owner-only: these keys can read every order and edit the catalogue.
  if (!can(access.role, "team", "full", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const state = await getWebsiteIntegration(slug);
  if ("ok" in state) redirect(`/${slug}/dashboard`);

  return (
    <div className="space-y-6">
      <PageHeader icon={<Globe />} color="sky" title="Website connection" />
      <WebsiteConnection slug={slug} state={state} />
    </div>
  );
}
