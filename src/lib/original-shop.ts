/**
 * Whether a workspace is the shop this app was originally built for.
 *
 * A few printable items — the gift tags and the promo leaflet — carry that
 * shop's own name, logo, social links and WhatsApp number as fixed content.
 * They are right for it and wrong for anyone else, so they are offered only
 * there. WOO_WORKSPACE_SLUG already names that workspace; when it is not set
 * (a single-shop deployment) every workspace counts, as before.
 */
export function isOriginalShop(slug: string): boolean {
  const only = process.env.WOO_WORKSPACE_SLUG;
  return !only || slug === only;
}
