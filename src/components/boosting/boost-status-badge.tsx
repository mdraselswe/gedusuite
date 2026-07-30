import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  ACTIVE: "bg-green-500/10 text-green-700 dark:text-green-400 border-transparent",
  PAUSED: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-transparent",
  COMPLETED: "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-transparent",
  CANCELLED: "bg-red-500/10 text-red-700 dark:text-red-400 border-transparent",
};

export function BoostStatusBadge({ status }: { status: string }) {
  return <Badge className={cn(STYLES[status])}>{status}</Badge>;
}
