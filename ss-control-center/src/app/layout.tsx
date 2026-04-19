import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/layout/AppShell";

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
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
