import { cn } from "@/lib/utils";
import { sectionColorClasses, type SectionColor } from "@/lib/section-colors";

/** Colored icon badge + title, used at the top of every module page for a
 * consistent, recognizable "this is the X section" visual anchor. */
export function PageHeader({
  icon,
  color,
  title,
  action,
}: {
  icon: React.ReactNode;
  color: SectionColor;
  title: React.ReactNode;
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
      </div>
      {action}
    </div>
  );
}
