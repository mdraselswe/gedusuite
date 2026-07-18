import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { isLocale, type Locale } from "@/lib/i18n";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
    const u = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { theme: true, colorPreset: true, locale: true },
    });
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <Providers prefs={{ theme, preset, locale }}>{children}</Providers>
      </body>
    </html>
  );
}
