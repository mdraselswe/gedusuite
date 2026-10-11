import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import type { MoneyTone } from "@/lib/money";
import {
  sectionBarClasses,
  sectionSolidClasses,
  type SectionColor,
} from "@/lib/section-colors";

/**
 * One headline figure, said once.
 *
 * The dashboard had a local StatCard, the partners page hand-rolled its own,
 * and the treasury a third — same intent, three sets of type sizes and three
 * ideas of where the sub-line goes, so figures of equal importance looked
 * different depending on which screen you were standing on.
 *
 * The label goes above the number rather than below it: a reader scanning a row
 * of tiles is looking for a name first and reads the figure once they've found
 * the right one.
 */
export function StatTile({
  label,
  value,
  tone = "neutral",
  icon,
  color,
  sub,
  footer,
  href,
  exact,
  className,
}: {
  label: React.ReactNode;
  /** A number is formatted as taka; a node is rendered as given (counts, dates). */
  value: number | React.ReactNode;
  tone?: MoneyTone;
  icon?: React.ReactNode;
  color?: SectionColor;
  /** One short line under the figure — a breakdown, a count, a comparison. */
  sub?: React.ReactNode;
  /** Anything richer: an InfoNote, a FigureList, a link. Sits below a rule. */
  footer?: React.ReactNode;
  href?: string;
  exact?: boolean;
  className?: string;
}) {
  const body = (
    <Card
      className={cn(
        "relative h-full gap-3 overflow-hidden",
        href && "hover:border-primary/40",
        className,
      )}
    >
      {color ? (
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 top-0 h-1 bg-gradient-to-r",
            sectionBarClasses[color],
          )}
        />
      ) : null}
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-0">
        {icon && (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg shadow-md [&_svg]:size-4",
              color ? sectionSolidClasses[color] : "bg-muted text-muted-foreground",
            )}
          >
            {icon}
          </span>
        )}
        <CardTitle className="text-[13px] font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="font-display text-[1.7rem] leading-tight font-semibold tracking-tight tabular-nums">
          {typeof value === "number" ? (
            <Money value={value} tone={tone} exact={exact} />
          ) : (
            value
          )}
        </div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
        {footer && <div className="border-t pt-2">{footer}</div>}
      </CardContent>
    </Card>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Even columns that collapse sensibly, so tiles never orphan on a phone. */
export function StatGrid({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}
      {...props}
    />
  );
}
