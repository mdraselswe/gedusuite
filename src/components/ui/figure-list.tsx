import * as React from "react";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import type { MoneyTone } from "@/lib/money";

/**
 * A label on the left, a figure on the right, and the figures under each other.
 *
 * The finance screens were full of hand-built rows — a flex here, a grid there,
 * some with the number bold and some not — so two lists of the same shape on
 * the same page didn't align with each other. Worse, the sub-figures that
 * explain a total ("of which 40,000 came from the treasury") were written as
 * prose underneath instead of sitting beneath the number they break down, which
 * is the arrangement that makes a breakdown readable without being read.
 */

export function FigureList({
  className,
  ...props
}: React.ComponentProps<"dl">) {
  return (
    <dl
      data-slot="figure-list"
      className={cn("grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm", className)}
      {...props}
    />
  );
}

export function FigureRow({
  label,
  value,
  tone = "neutral",
  /** Indents the label and mutes it: a component of the row above, not a peer. */
  sub,
  /** For the line a group adds up to — heavier, with a rule above it. */
  total,
  hint,
  exact,
  signed,
  className,
}: {
  label: React.ReactNode;
  value: number;
  tone?: MoneyTone;
  sub?: boolean;
  total?: boolean;
  /** A few words under the label. Anything longer belongs in an InfoNote. */
  hint?: React.ReactNode;
  exact?: boolean;
  signed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "col-span-2 grid grid-cols-subgrid items-baseline",
        total && "mt-1 border-t pt-2",
        className,
      )}
    >
      <dt
        className={cn(
          "min-w-0",
          sub && "pl-4 text-muted-foreground",
          total ? "font-medium text-foreground" : !sub && "text-muted-foreground",
        )}
      >
        {label}
        {hint && <span className="block text-xs text-muted-foreground/80">{hint}</span>}
      </dt>
      <dd className={cn("justify-self-end", total ? "font-semibold" : "font-medium")}>
        <Money value={value} tone={tone} exact={exact} signed={signed} />
      </dd>
    </div>
  );
}
