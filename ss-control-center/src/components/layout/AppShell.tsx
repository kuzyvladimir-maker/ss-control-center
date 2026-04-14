"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useMounted } from "@/lib/use-mounted";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const mounted = useMounted();
  const pathname = usePathname();

  // Login page renders without the app shell (no sidebar/header)
  if (pathname === "/login") {
    return <>{children}</>;
  }

  if (!mounted) {
    // Return a minimal shell so SSR and client match (empty, no dates)
    return <div className="flex h-screen w-full" />;
  }

  return (
    <TooltipProvider>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </TooltipProvider>
  );
}
