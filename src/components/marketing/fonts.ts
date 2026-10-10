import { Bricolage_Grotesque } from "next/font/google";

/**
 * The marketing pages' display face. Chosen for its slightly irregular,
 * hand-lettered-in-metal feel — a shop's price tag rather than a SaaS
 * brochure — and used only for headlines and figures. Body text stays in the
 * app's own families so the public site and the product read as one thing.
 */
export const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  axes: ["opsz"],
});
