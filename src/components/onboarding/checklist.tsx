import Link from "next/link";
import { Check } from "lucide-react";
import type { Onboarding } from "@/lib/onboarding";

/** The first-week checklist on a new workspace's dashboard. */
export function OnboardingChecklist({ data }: { data: Onboarding }) {
  const required = data.steps.filter((s) => !s.optional);
  const optional = data.steps.filter((s) => s.optional);
  const allRequiredDone = data.progress.done === data.progress.total;

  return (
    <section
      aria-labelledby="getting-started"
      className="rounded-xl border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="getting-started" className="text-lg font-semibold">
          {allRequiredDone ? "You are up and running" : "Get your shop set up"}
        </h2>
        <span className="text-sm tabular-nums text-muted-foreground">
          {data.progress.done} of {data.progress.total} done
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${(data.progress.done / data.progress.total) * 100}%` }}
        />
      </div>

      <ol className="mt-5 grid gap-3 md:grid-cols-3">
        {required.map((s, i) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className={`flex h-full gap-3 rounded-lg border p-3 transition-colors hover:border-primary/50 ${
                s.done ? "bg-muted/40" : ""
              }`}
            >
              <span
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  s.done ? "bg-primary text-primary-foreground" : "border"
                }`}
              >
                {s.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span>
                <span className={`block text-sm font-medium ${s.done ? "line-through opacity-60" : ""}`}>
                  {s.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{s.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>

      <p className="mt-5 text-sm font-medium">Also worth doing</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {optional.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              title={s.hint}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs hover:border-primary/50 ${
                s.done ? "text-muted-foreground line-through" : ""
              }`}
            >
              {s.done ? <Check className="size-3" /> : null}
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
