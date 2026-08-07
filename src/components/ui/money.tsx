import { cn } from "@/lib/utils";
import {
  formatMoney,
  moneyToneClass,
  type MoneyFormat,
  type MoneyTone,
} from "@/lib/money";

/**
 * A taka figure on screen.
 *
 * `tabular-nums` is the whole reason this is a component and not a bare call to
 * formatMoney: in a proportional font the digits of a column are different
 * widths, so 1,24,000 and 9,99,999 don't line up and a stack of figures can't
 * be scanned. Every number in this app that means money goes through here.
 */
export function Money({
  value,
  tone = "neutral",
  className,
  ...opts
}: {
  value: number;
  /**
   * What the figure MEANS. Never inferred from the sign — an expense of
   * ৳3,12,450 is a positive number and not good news. See MoneyTone.
   */
  tone?: MoneyTone;
  className?: string;
} & MoneyFormat) {
  return (
    <span className={cn("tabular-nums", moneyToneClass[tone], className)}>
      {formatMoney(value, opts)}
    </span>
  );
}
