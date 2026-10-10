import Link from "next/link";
import { redirect } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { PageHeader } from "@/components/ui/page-header";
import { SupportForm } from "@/components/help/support-form";

export default async function HelpPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");

  const phone = process.env.BILLING_SUPPORT_PHONE;
  const email = process.env.BILLING_SUPPORT_EMAIL;

  return (
    <div className="space-y-6">
      <PageHeader icon={<LifeBuoy />} color="sky" title="Help & support" />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Send us a message</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us what you were trying to do and what happened. We reply to the email on your
            account.
          </p>
          <div className="mt-4">
            <SupportForm slug={slug} />
          </div>
        </section>

        <aside className="space-y-4 text-sm">
          {phone || email ? (
            <div className="rounded-xl border bg-card p-5">
              <h2 className="font-semibold">Reach us directly</h2>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {phone ? <li>{phone}</li> : null}
                {email ? <li>{email}</li> : null}
              </ul>
            </div>
          ) : null}
          <div className="rounded-xl border bg-card p-5">
            <h2 className="font-semibold">Good to know</h2>
            <ul className="mt-2 space-y-2 text-muted-foreground">
              <li>
                Your data is yours. Download a full backup from{" "}
                <Link className="underline" href={`/${slug}/settings/backup`}>
                  Backup
                </Link>{" "}
                at any time.
              </li>
              <li>
                Plan, limits and payments are under{" "}
                <Link className="underline" href={`/${slug}/settings/billing`}>
                  Plan &amp; billing
                </Link>
                .
              </li>
              <li>
                <Link className="underline" href="/terms">
                  Terms
                </Link>
                {" · "}
                <Link className="underline" href="/privacy">
                  Privacy
                </Link>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
