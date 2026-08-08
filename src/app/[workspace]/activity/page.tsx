import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { entityLabel } from "@/lib/activity";
import { activityActors, activityEntities, readActivity } from "@/lib/activity-read";
import { ActivityEntries } from "@/components/activity/activity-entries";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { History } from "lucide-react";

/**
 * Who changed what, across the whole workspace.
 *
 * Owner and Partner only (see the RBAC matrix): they own the business between
 * them. Knowing their work is recorded is the point for everyone else; reading
 * each other's is not.
 */
export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    page?: string;
    actor?: string;
    entity?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "activity", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const filters = {
    actor: (sp.actor ?? "").trim() || undefined,
    entity: (sp.entity ?? "").trim() || undefined,
    from: (sp.from ?? "").trim() || undefined,
    to: (sp.to ?? "").trim() || undefined,
  };

  const [{ entries, total, pageSize }, actors, entities] = await Promise.all([
    readActivity(access.workspaceId, filters, page),
    activityActors(access.workspaceId),
    activityEntities(access.workspaceId),
  ]);

  // Links rather than a client form: the filters are four values in the URL,
  // which makes a filtered view something you can send to somebody.
  const href = (over: Partial<typeof filters> & { page?: number }) => {
    const q = new URLSearchParams();
    const merged = { ...filters, ...over };
    if (merged.actor) q.set("actor", merged.actor);
    if (merged.entity) q.set("entity", merged.entity);
    if (merged.from) q.set("from", merged.from);
    if (merged.to) q.set("to", merged.to);
    const s = q.toString();
    return `/${slug}/activity${s ? `?${s}` : ""}`;
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
    }`;

  return (
    <div className="space-y-6">
      <PageHeader icon={<History />} color="slate" title="Activity" count={total} />

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Who</span>
            <Link href={href({ actor: undefined })} className={chip(!filters.actor)}>
              Everyone
            </Link>
            {actors.map((a) => (
              <Link key={a.id} href={href({ actor: a.id })} className={chip(filters.actor === a.id)}>
                {a.label}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">What</span>
            <Link href={href({ entity: undefined })} className={chip(!filters.entity)}>
              Everything
            </Link>
            {entities.map((e) => (
              <Link key={e} href={href({ entity: e })} className={chip(filters.entity === e)}>
                {entityLabel(e)}
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-2">
          <ActivityEntries entries={entries} />
        </CardContent>
      </Card>

      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / pageSize))}
        basePath={`/${slug}/activity`}
        query={filters}
      />
    </div>
  );
}
