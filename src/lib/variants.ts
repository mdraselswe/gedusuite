/**
 * Helpers for the flexible product-variant model. A variant's attribute
 * combination is stored as JSON on ProductVariant.attributes in the shape
 * [{ name, value }] (e.g. [{ name: "Size", value: "M" }, ...]). These helpers
 * safely read that JSON and render it, replacing the size/color string
 * concatenation that used to be duplicated across the app.
 */

export type VariantAttribute = { name: string; value: string };

/** Safely coerce a ProductVariant.attributes JSON value into a typed array. */
export function variantAttributes(raw: unknown): VariantAttribute[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is VariantAttribute =>
      !!a &&
      typeof a === "object" &&
      typeof (a as Record<string, unknown>).name === "string" &&
      typeof (a as Record<string, unknown>).value === "string" &&
      String((a as VariantAttribute).value).trim() !== "",
  );
}

/** Compact values-only text: "M / Red" (empty string when no attributes). */
export function variantValues(raw: unknown): string {
  return variantAttributes(raw)
    .map((a) => a.value)
    .join(" / ");
}

/** Suffix form appended to a product name: " (M / Red)" or "". */
export function variantSuffix(raw: unknown): string {
  const s = variantValues(raw);
  return s ? ` (${s})` : "";
}

/** Standalone chip/label: "M / Red", or "default" for an attribute-less variant. */
export function variantChip(raw: unknown): string {
  return variantValues(raw) || "default";
}

/** Full display name: "Product name (M / Red)". */
export function variantFullName(productName: string, raw: unknown): string {
  return productName + variantSuffix(raw);
}

/** Labelled form for detailed contexts: "Size: M / Color: Red". */
export function variantLabelled(raw: unknown): string {
  return variantAttributes(raw)
    .map((a) => `${a.name}: ${a.value}`)
    .join(" / ");
}
