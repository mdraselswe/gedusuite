import { cn } from "@/lib/utils";
import { sectionColorClasses, type SectionColor } from "@/lib/section-colors";

/** Colored icon badge + title, used at the top of every module page for a
 * consistent, recognizable "this is the X section" visual anchor. */
export function PageHeader({
  icon,
  color,
  title,
  count,
  action,
}: {
  icon: React.ReactNode;
  color: SectionColor;
  title: React.ReactNode;
  /** Total record count for this module's list, shown as a pill by the title. */
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5",
            sectionColorClasses[color],
          )}
        >
          {icon}
        </span>
        <h1 className="text-2xl font-bold">{title}</h1>
        {typeof count === "number" && (
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums",
              sectionColorClasses[color],
            )}
          >
            {count}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}
