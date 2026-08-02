// Deterministic "same key -> same color" row tagging for DataTable's optional
// colorGroupBy (e.g. tag every row from the same date the same color). Fixed
// hue order, first-seen assignment, cycles after 8 distinct keys — mirrors
// the app's sectionColorClasses convention (see section-colors.ts) rather
// than inventing a new palette system.
const ROW_TAG_CLASSES = [
  "border-l-blue-500 bg-blue-500/8",
  "border-l-orange-500 bg-orange-500/8",
  "border-l-emerald-500 bg-emerald-500/8",
  "border-l-amber-500 bg-amber-500/8",
  "border-l-pink-500 bg-pink-500/8",
  "border-l-teal-500 bg-teal-500/8",
  "border-l-violet-500 bg-violet-500/8",
  "border-l-red-500 bg-red-500/8",
] as const;

/** Maps each distinct key to a stable Tailwind class pair, in first-seen order. */
export function assignRowColorSlots<T>(
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, string> {
  const slots = new Map<string, string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!slots.has(key)) {
      slots.set(key, ROW_TAG_CLASSES[slots.size % ROW_TAG_CLASSES.length]);
    }
  }
  return slots;
}
