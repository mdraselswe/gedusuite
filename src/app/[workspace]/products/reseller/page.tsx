import Link from "next/link";
import { redirect } from "next/navigation";
import { Tags } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { loadResellerList } from "@/lib/reseller-list";
import { parseViewers } from "@/lib/reseller-sync";
import { sheetUrl } from "@/lib/reseller-sheet";
import { personalBackupConfigured } from "@/lib/google-personal";
import { dhakaStampLine } from "@/lib/dhaka-time";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ResellerSettingsForm } from "@/components/products/reseller/reseller-settings-form";
import { ResellerPriceTable } from "@/components/products/reseller/reseller-price-table";
import { ResellerGoogleCard } from "@/components/products/reseller/reseller-google-card";

/**
 * The shop's side of the reseller price list: every figure, cost and profit
 * included. Resellers never come here — what they get is the Google Sheet and
 * the PDF, both built from the reseller-only rows.
 */
export default async function ResellerPricePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ google?: string; reason?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (
    !can(access.role, "products", "view", access.permissions) ||
    !can(access.role, "reports", "view", access.permissions)
  ) {
    redirect(`/${slug}/products`);
  }
  const canEdit = can(access.role, "products", "edit", access.permissions);

  const [{ settings, rows, resellerRows }, list] = await Promise.all([
    loadResellerList(access.workspaceId),
    prisma.resellerPriceList.findUnique({ where: { workspaceId: access.workspaceId } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Tags />}
        color="violet"
        title="Reseller price list"
        count={resellerRows.length}
        action={
          <div className="flex flex-wrap gap-2">
            <Link href={`/${slug}/products`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              ← Products
            </Link>
            <Link
              href={`/${slug}/products/reseller/pdf`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Reseller PDF
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ResellerSettingsForm slug={slug} settings={settings} canEdit={canEdit} />
        <ResellerGoogleCard
          slug={slug}
          canEdit={canEdit}
          notice={sp.google === "connected" ? "connected" : sp.google === "error" ? (sp.reason ?? "Google sign-in failed") : null}
          state={{
            configured: personalBackupConfigured(),
            connected: !!list?.googleAccessToken,
            email: list?.googleEmail ?? null,
            sheetUrl: list?.sheetId ? sheetUrl(list.sheetId) : null,
            viewers: parseViewers(list?.viewers),
            publicLink: list?.publicLink ?? false,
            lastSyncedAt: list?.lastSyncedAt ? dhakaStampLine(list.lastSyncedAt) : null,
            lastSyncError: list?.lastSyncError ?? null,
          }}
        />
      </div>

      <ResellerPriceTable
        slug={slug}
        canEdit={canEdit}
        rows={rows}
        pricing={{ tiers: settings.tiers, minMarginPct: settings.minMarginPct, roundTo: settings.roundTo }}
      />
    </div>
  );
}
