"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { TAKA, formatMoney } from "@/lib/money";

/**
 * An amount box that looks like the amounts everywhere else.
 *
 * The ৳ sits inside the field rather than in the label, so a row of amount
 * boxes reads as money at a glance; digits are tabular and right-aligned, so a
 * column of them lines up the way the tables now do. The value stays a plain
 * `type="number"` string underneath — grouping separators inside an input are
 * a well-known way to break arrow keys, mobile keypads and the browser's own
 * validation, so this shows the grouped figure UNDER the box instead once it
 * gets long enough to be worth reading.
 *
 * A drop-in for <Input type="number">: same name, same value, same FormData.
 */
export function MoneyInput({
  className,
  value,
  showFormatted = true,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type"> & {
  /** Echo the grouped figure below the box once it's four digits or more. */
  showFormatted?: boolean;
}) {
  const numeric =
    typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  // Below a thousand the grouping adds nothing, and echoing "৳50" under a box
  // that says 50 is just noise.
  const echo =
    showFormatted && Number.isFinite(numeric) && Math.abs(numeric) >= 1000
      ? formatMoney(numeric)
      : null;

  return (
    <div className="space-y-1">
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-sm text-muted-foreground"
        >
          {TAKA}
        </span>
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          value={value}
          className={cn("pl-6 text-right tabular-nums", className)}
          {...props}
        />
      </div>
      {echo && (
        <p className="text-right text-xs text-muted-foreground tabular-nums">{echo}</p>
      )}
    </div>
  );
}
