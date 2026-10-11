import { cn } from "@/lib/utils";
import {
  sectionColorClasses,
  sectionSolidClasses,
  sectionWashClasses,
  type SectionColor,
} from "@/lib/section-colors";

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
    <div className="relative flex flex-wrap items-center justify-between gap-3">
      {/* The page's own colour, as a glow behind the title. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-8 -left-6 -z-10 h-28 w-80 max-w-full rounded-full bg-gradient-to-r to-transparent blur-3xl",
          sectionWashClasses[color],
        )}
        style={{ animation: "drift 14s ease-in-out infinite" }}
      />
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl shadow-lg [&_svg]:size-5",
            sectionSolidClasses[color],
          )}
        >
          {icon}
        </span>
        <h1 className="font-display text-[1.65rem] leading-none font-bold tracking-tight">{title}</h1>
        {typeof count === "number" && (
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums",
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
