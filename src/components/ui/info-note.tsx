"use client";

import * as React from "react";
import { ChevronDown, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The explanation behind a figure, folded away until somebody wants it.
 *
 * This app knows a lot about why its numbers are what they are, and it used to
 * say all of it at once: a hundred-odd blocks of `text-xs text-muted-foreground`
 * prose sitting under cards, several sentences long, explaining treasury
 * funding and untagged purchases to someone who had come to read one number.
 * The information is genuinely worth having — it is the difference between
 * trusting a figure and taking it on faith — but not at the same moment as the
 * figure, and not at the same weight.
 *
 * So: a one-line summary that is always visible, and the reasoning behind a
 * disclosure. Native <details>, so it works before hydration, is keyboard
 * operable for free, and prints open in the browser's print view.
 */
export function InfoNote({
  title,
  tone = "info",
  defaultOpen = false,
  children,
  className,
}: {
  /** The one line that is always on screen. Say the conclusion, not the topic. */
  title: React.ReactNode;
  /** `warn` for something the reader must act on, `info` for background. */
  tone?: "info" | "warn";
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === "warn" ? TriangleAlert : Info;
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group/note rounded-lg border text-sm [&[open]>summary_svg.chev]:rotate-180",
        tone === "warn"
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-border bg-muted/40",
        className,
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-start gap-2 rounded-lg px-3 py-2 outline-none",
          "hover:bg-foreground/[0.03] focus-visible:ring-3 focus-visible:ring-ring/50",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 font-medium",
            tone === "warn" ? "text-amber-900 dark:text-amber-200" : "text-foreground",
          )}
        >
          {title}
        </span>
        <ChevronDown className="chev mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform" />
      </summary>
      {/* Indented to the summary's text, so the explanation reads as belonging
          to the line above rather than starting a new thought. */}
      <div className="space-y-2 px-3 pb-3 pl-9 text-muted-foreground">{children}</div>
    </details>
  );
}
