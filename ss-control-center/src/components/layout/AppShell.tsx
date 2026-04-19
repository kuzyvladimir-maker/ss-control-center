"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
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
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden bg-bg">
        <Header />
        <main className="flex-1 overflow-auto" style={{ padding: "var(--content-padding)" }}>
          <div className="mx-auto" style={{ maxWidth: "var(--content-max)" }}>
            {children}
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
