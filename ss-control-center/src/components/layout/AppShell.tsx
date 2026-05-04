"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import Header from "@/components/layout/Header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useMounted } from "@/lib/use-mounted";

const STANDALONE_PREFIXES = ["/login", "/invite"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const mounted = useMounted();
  const pathname = usePathname();

  if (STANDALONE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return <>{children}</>;
  }

  if (!mounted) {
    return <div className="flex h-screen w-full bg-bg" />;
  }

  return (
    <TooltipProvider>
      {/* Desktop sidebar — hidden below md, visible md+ via Sidebar's own classes */}
      <Sidebar />
      {/* Mobile drawer — controlled by MobileNavContext, opens via hamburger */}
      <MobileNav />
      <div className="flex flex-1 flex-col overflow-hidden bg-bg">
        <Header />
        <main className="flex-1 overflow-auto">
          {/* Padding mirrors --content-padding (28px 32px 40px) on desktop and
              compresses to 16px on mobile so 380px iPhones don't lose ~17%
              of viewport width to side gutters. */}
          <div
            className="mx-auto px-4 pt-4 pb-6 md:px-8 md:pt-7 md:pb-10"
            style={{ maxWidth: "var(--content-max)" }}
          >
            {children}
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
