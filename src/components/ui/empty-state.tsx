import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { sectionColorClasses, type SectionColor } from "@/lib/section-colors";

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  color = "slate",
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  color?: SectionColor;
}) {
  return (
    <div className="flex animate-in flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center fade-in-0 zoom-in-95 duration-300">
      <div
        className={cn(
          "flex size-14 items-center justify-center rounded-full",
          sectionColorClasses[color],
        )}
      >
        <Icon className="size-7" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-xs text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
