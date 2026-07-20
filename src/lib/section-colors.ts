// One accent color per app section/module — reused by the sidebar nav,
// empty states, and page headers so a given module (e.g. Treasury) always
// reads the same color everywhere instead of a uniform muted gray.
export const sectionColorClasses = {
  slate: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  pink: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  cyan: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  indigo: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  teal: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  rose: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
} satisfies Record<string, string>;

export type SectionColor = keyof typeof sectionColorClasses;
