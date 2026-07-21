import type { Metadata, Viewport } from "next";
import { Inter, Hind_Siliguri, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { auth } from "@/lib/session";
import { getUserPrefs } from "@/lib/user-prefs";
import { isLocale, type Locale } from "@/lib/i18n";

// Separate, script-optimized fonts instead of one font for both: Inter reads
// better for English UI text, Hind Siliguri reads better for Bangla. Which one
// is primary swaps with `html[lang]` (see globals.css); the other stays as a
// fallback so mixed-script content (e.g. a Bangla name on an English-locale
// page) still renders with its own well-hinted font instead of tofu/system.
const inter = Inter({
  variable: "--font-en",
  subsets: ["latin"],
  display: "swap",
});

const hindSiliguri = Hind_Siliguri({
  variable: "--font-bn",
  subsets: ["bengali", "latin"],
  weight: ["300", "400", "500", "600", "700"],
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
  icons: { apple: "/icons/apple-touch-icon.png" },
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
      className={`${inter.variable} ${hindSiliguri.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <Providers prefs={{ theme, preset, locale }}>{children}</Providers>
      </body>
    </html>
  );
}
