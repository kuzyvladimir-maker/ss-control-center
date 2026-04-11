"use client";

import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/lib/use-mounted";

const pageTitles: Record<string, string> = {
  "/": "Dashboard",
  "/shipping": "Shipping Labels",
  "/customer-hub": "Customer Hub",
  "/claims/atoz": "A-to-Z Claims",
  "/feedback": "Feedback",
  "/account-health": "Account Health",
  "/frozen-analytics": "Frozen Analytics",
  "/adjustments": "Adjustments",
  "/listings": "Product Listings",
  "/analytics": "Sales Analytics",
  "/suppliers": "Suppliers",
  "/promotions": "Promotions",
  "/integrations": "Integrations",
  "/settings": "Settings",
};

export default function Header() {
  const pathname = usePathname();
  const title = pageTitles[pathname] || "SS Control Center";
  const mounted = useMounted();
  const today = mounted
    ? new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      })
    : "";

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
      <div className="flex items-center gap-4">
        {mounted && today && (
          <span className="text-sm text-slate-500">{today}</span>
        )}
        <Button variant="ghost" size="icon" className="relative">
          <Bell size={18} />
        </Button>
      </div>
    </header>
  );
}
