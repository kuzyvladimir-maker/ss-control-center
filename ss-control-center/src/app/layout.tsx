import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/layout/AppShell";
import { MobileNavProvider } from "@/lib/mobile-nav-context";

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Salutem Control",
  description: "Salutem Solutions E-Commerce Control Center",
  manifest: "/manifest.json",
  // iOS Home Screen treatment — when Vladimir uses
  // Share → "Add to Home Screen" on iPhone, the page launches
  // fullscreen (no browser chrome) and looks like a native app.
  appleWebApp: {
    capable: true,
    title: "Salutem",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#1F4D3F",
  // Don't let iOS auto-zoom when tapping inputs on the procurement page.
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning={true}
      className={`${interTight.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body
        suppressHydrationWarning={true}
        className="flex h-screen overflow-hidden bg-bg text-ink"
      >
        <MobileNavProvider>
          <AppShell>{children}</AppShell>
        </MobileNavProvider>
      </body>
    </html>
  );
}
