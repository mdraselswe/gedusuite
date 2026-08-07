import { redirect } from "next/navigation";
import { Coins } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { spendingForRange } from "@/lib/spending";
import { dhakaDayEnd, dhakaDayStart, dhakaDaysAgo, dhakaToday } from "@/lib/dhaka-time";
import { PageHeader } from "@/components/ui/page-header";
import { ExpensesView } from "@/components/expenses/expenses-view";

/**
 * Where the money went on a given day.
 *
 * Defaults to today and to a single day, because the question this answers is
 * a daily one — "what went out today" — asked at a different moment from the
 * monthly report, which is why it isn't a tab on it.
 */
export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  // Gated with purchases: this is the spending side of the same information,
  // and STAFF — who may add a purchase but not see business totals — has no
  // more business with a day's spend than with a report.
  if (!can(access.role, "purchases", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  // Dhaka days, like every other range in the app: built with setHours() they
  // would anchor to the server's midnight (UTC on Vercel) and an order taken
  // late in the evening would land on the next day.
  const today = dhakaToday();
  const fromDay = sp.from ?? today;
  const toDay = sp.to ?? fromDay;
  const range = { from: dhakaDayStart(fromDay), to: dhakaDayEnd(toDay) };
  if (Number.isNaN(range.from.getTime()) || Number.isNaN(range.to.getTime())) {
    redirect(`/${slug}/expenses`);
  }

  const summary = await spendingForRange(access.workspaceId, range, slug);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Coins />}
        color="orange"
        title="Spending"
        action={
          <span className="text-sm text-muted-foreground">
            {summary.rows.length} entr{summary.rows.length === 1 ? "y" : "ies"}
          </span>
        }
      />
      <ExpensesView
        slug={slug}
        from={fromDay}
        to={toDay}
        today={today}
        weekAgo={dhakaDaysAgo(6)}
        monthStart={`${today.slice(0, 7)}-01`}
        summary={summary}
      />
    </div>
  );
}
