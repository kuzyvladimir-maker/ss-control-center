"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";

const pageTitles: Record<string, string> = {
  "/": "Dashboard",
  "/shipping": "Shipping Labels",
  "/customer-service": "Customer Service",
  "/listings": "Product Listings",
  "/analytics": "Sales Analytics",
  "/suppliers": "Suppliers",
  "/promotions": "Promotions",
  "/settings": "Settings",
};

export default function Header() {
  const pathname = usePathname();
  const title = pageTitles[pathname] || "SS Control Center";
  const [mounted, setMounted] = useState(false);
  const [today, setToday] = useState("");

  useEffect(() => {
    setMounted(true);
    setToday(
      new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      })
    );
  }, []);

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
