import Link from "next/link";

/** A plain, honest notice about the plan — never blocks anything by itself. */
export function SubscriptionBanner({
  slug,
  state,
  daysLeft,
  owner,
}: {
  slug: string;
  state: "trial" | "grace" | "readonly";
  daysLeft: number | null;
  owner: boolean;
}) {
  const tone =
    state === "readonly"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  const text =
    state === "readonly"
      ? "This workspace is read-only until the plan is renewed. Nothing has been removed."
      : state === "grace"
        ? "Your plan has expired. Renew now to avoid the workspace becoming read-only."
        : `Your free trial ends in ${daysLeft ?? 0} day(s).`;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm ${tone}`}
    >
      <span>{text}</span>
      {owner ? (
        <Link href={`/${slug}/settings/billing`} className="font-medium underline underline-offset-4">
          Choose a plan
        </Link>
      ) : (
        <span>Ask the workspace owner to renew.</span>
      )}
    </div>
  );
}
