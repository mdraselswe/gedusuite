// One accent color per app section/module — reused by the sidebar nav,
// empty states, page headers and stat tiles so a given module (e.g. Treasury)
// always reads the same color everywhere. Color is wayfinding here: it tells
// you which part of the business you are standing in.
export const sectionColorClasses = {
  slate: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  pink: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  cyan: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  indigo: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  teal: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  rose: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
} satisfies Record<string, string>;

export type SectionColor = keyof typeof sectionColorClasses;

/** A solid gradient chip with a white icon — the loud version of the tint. */
export const sectionSolidClasses: Record<SectionColor, string> = {
  slate: "bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-slate-500/30",
  blue: "bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-blue-500/35",
  violet: "bg-gradient-to-br from-violet-400 to-purple-600 text-white shadow-violet-500/35",
  orange: "bg-gradient-to-br from-amber-400 to-orange-600 text-white shadow-orange-500/35",
  emerald: "bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-emerald-500/35",
  pink: "bg-gradient-to-br from-pink-400 to-rose-600 text-white shadow-pink-500/35",
  cyan: "bg-gradient-to-br from-cyan-400 to-sky-600 text-white shadow-cyan-500/35",
  amber: "bg-gradient-to-br from-yellow-400 to-amber-600 text-white shadow-amber-500/35",
  sky: "bg-gradient-to-br from-sky-400 to-indigo-500 text-white shadow-sky-500/35",
  indigo: "bg-gradient-to-br from-indigo-400 to-violet-600 text-white shadow-indigo-500/35",
  teal: "bg-gradient-to-br from-teal-400 to-emerald-600 text-white shadow-teal-500/35",
  rose: "bg-gradient-to-br from-rose-400 to-red-600 text-white shadow-rose-500/35",
  fuchsia: "bg-gradient-to-br from-fuchsia-400 to-purple-600 text-white shadow-fuchsia-500/35",
};

/** A soft glow behind a page header, in the page's own color. */
export const sectionWashClasses: Record<SectionColor, string> = {
  slate: "from-slate-400/25 via-slate-300/10",
  blue: "from-blue-400/30 via-sky-300/10",
  violet: "from-violet-400/30 via-purple-300/10",
  orange: "from-orange-400/30 via-amber-300/10",
  emerald: "from-emerald-400/30 via-teal-300/10",
  pink: "from-pink-400/30 via-rose-300/10",
  cyan: "from-cyan-400/30 via-sky-300/10",
  amber: "from-amber-400/30 via-yellow-300/10",
  sky: "from-sky-400/30 via-indigo-300/10",
  indigo: "from-indigo-400/30 via-violet-300/10",
  teal: "from-teal-400/30 via-emerald-300/10",
  rose: "from-rose-400/30 via-red-300/10",
  fuchsia: "from-fuchsia-400/30 via-purple-300/10",
};

/** A thin colored edge along the top of a stat tile. */
export const sectionBarClasses: Record<SectionColor, string> = {
  slate: "from-slate-400 to-slate-600",
  blue: "from-sky-400 to-blue-600",
  violet: "from-violet-400 to-purple-600",
  orange: "from-amber-400 to-orange-600",
  emerald: "from-emerald-400 to-teal-600",
  pink: "from-pink-400 to-rose-600",
  cyan: "from-cyan-400 to-sky-600",
  amber: "from-yellow-400 to-amber-600",
  sky: "from-sky-400 to-indigo-500",
  indigo: "from-indigo-400 to-violet-600",
  teal: "from-teal-400 to-emerald-600",
  rose: "from-rose-400 to-red-600",
  fuchsia: "from-fuchsia-400 to-purple-600",
};
