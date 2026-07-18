export const locales = ["en", "bn"] as const;
export type Locale = (typeof locales)[number];

// UI string dictionary. English is the source of truth; Bangla mirrors it.
// Extend both maps together as more of the UI is localized.
const en = {
  dashboard: "Dashboard",
  products: "Products",
  purchases: "Purchases",
  sales: "Sales",
  customers: "Customers",
  partners: "Partners",
  treasury: "Treasury",
  internal: "Internal",
  reports: "Reports",
  team: "Team",
  backup: "Backup",
  appearance: "Appearance",
  notifications: "Notifications",
  signOut: "Sign out",
  language: "Language",
  theme: "Theme",
  colorPreset: "Color",
  light: "Light",
  dark: "Dark",
  system: "System",
  save: "Save",
  productsSuppliers: "Products & Suppliers",
  salesOrders: "Sales & Orders",
  internalPurchases: "Internal Purchases",
  backupRecovery: "Backup & Recovery",
} as const;

export type MsgKey = keyof typeof en;

const bn: Record<MsgKey, string> = {
  dashboard: "ড্যাশবোর্ড",
  products: "পণ্য",
  purchases: "ক্রয়",
  sales: "বিক্রয়",
  customers: "গ্রাহক",
  partners: "পার্টনার",
  treasury: "কোষাগার",
  internal: "অভ্যন্তরীণ",
  reports: "রিপোর্ট",
  team: "টিম",
  backup: "ব্যাকআপ",
  appearance: "অ্যাপিয়ারেন্স",
  notifications: "নোটিফিকেশন",
  signOut: "সাইন আউট",
  language: "ভাষা",
  theme: "থিম",
  colorPreset: "রঙ",
  light: "লাইট",
  dark: "ডার্ক",
  system: "সিস্টেম",
  save: "সংরক্ষণ",
  productsSuppliers: "পণ্য ও সরবরাহকারী",
  salesOrders: "বিক্রয় ও অর্ডার",
  internalPurchases: "অভ্যন্তরীণ ক্রয়",
  backupRecovery: "ব্যাকআপ ও রিকভারি",
};

const dict: Record<Locale, Record<MsgKey, string>> = { en, bn };

export function translate(locale: Locale, key: MsgKey): string {
  return dict[locale]?.[key] ?? dict.en[key] ?? key;
}

export function isLocale(v: unknown): v is Locale {
  return v === "en" || v === "bn";
}
