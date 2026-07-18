import type { Metadata, Viewport } from "next";
import { Anek_Bangla, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { auth } from "@/lib/session";
import { getUserPrefs } from "@/lib/user-prefs";
import { isLocale, type Locale } from "@/lib/i18n";

// Anek Bangla renders Bangla + Latin in one visual rhythm — primary UI font
// (TECH_SPEC §10). Loaded as the --font-sans variable.
const anekBangla = Anek_Bangla({
  variable: "--font-sans",
  subsets: ["bengali", "latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GeduSuite",
  description: "Multi-tenant business management PWA",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "GeduSuite" },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Load the signed-in user's saved appearance prefs (server-side, no flash).
  let theme = "system";
  let preset = "indigo";
  let locale: Locale = "en";
  const session = await auth();
  if (session?.user?.id) {
    const u = await getUserPrefs(session.user.id);
    if (u) {
      theme = u.theme;
      preset = u.colorPreset;
      if (isLocale(u.locale)) locale = u.locale;
    }
  }

  return (
    <html
      lang={locale}
      data-preset={preset}
      className={`${anekBangla.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <Providers prefs={{ theme, preset, locale }}>{children}</Providers>
      </body>
    </html>
  );
}
