"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, LogOut, ShieldCheck } from "lucide-react";
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
  "/settings/users": "User Permissions",
};

interface MeUser {
  username: string;
  displayName: string | null;
  role: string;
}

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const title = pageTitles[pathname] || "SS Control Center";
  const mounted = useMounted();
  const [me, setMe] = useState<MeUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.user) setMe(j.user);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const today = mounted
    ? new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      })
    : "";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
      <div className="flex items-center gap-4">
        {mounted && today && (
          <span className="text-sm text-slate-500">{today}</span>
        )}
        {me && (
          <span
            className="inline-flex items-center gap-1 text-xs text-slate-600"
            title={me.username}
          >
            {me.role === "admin" && (
              <ShieldCheck size={12} className="text-blue-500" />
            )}
            {me.displayName || me.username}
          </span>
        )}
        <Button variant="ghost" size="icon" className="relative">
          <Bell size={18} />
        </Button>
        {me && (
          <Button
            variant="ghost"
            size="icon"
            onClick={logout}
            title="Sign out"
          >
            <LogOut size={18} />
          </Button>
        )}
      </div>
    </header>
  );
}
