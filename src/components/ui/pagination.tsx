import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/** Page-number pagination for server-rendered lists. basePath should NOT include query string. */
export function Pagination({
  page,
  totalPages,
  basePath,
}: {
  page: number;
  totalPages: number;
  basePath: string;
}) {
  if (totalPages <= 1) return null;

  const linkClass = cn(buttonVariants({ variant: "outline", size: "sm" }));
  const disabledClass = "pointer-events-none opacity-50";

  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      {page > 1 ? (
        <Link href={`${basePath}?page=${page - 1}`} className={linkClass}>
          Prev
        </Link>
      ) : (
        <span className={cn(linkClass, disabledClass)}>Prev</span>
      )}
      <span className="text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={`${basePath}?page=${page + 1}`} className={linkClass}>
          Next
        </Link>
      ) : (
        <span className={cn(linkClass, disabledClass)}>Next</span>
      )}
    </div>
  );
}

/** Parse a ?page= searchParam into a valid 1-based page number. */
export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
