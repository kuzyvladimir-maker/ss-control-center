"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, LogOut, Search, ShieldCheck } from "lucide-react";
import { useMounted } from "@/lib/use-mounted";

interface MeUser {
  username: string;
  displayName: string | null;
  role: string;
}

export default function Header() {
  const router = useRouter();
  const mounted = useMounted();
  const [me, setMe] = useState<MeUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.user) setMe(j.user);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials =
    me?.displayName
      ?.split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ||
    me?.username?.slice(0, 2).toUpperCase() ||
    "U";

  return (
    <header
      className="flex shrink-0 items-center gap-3 border-b border-rule bg-surface px-6"
      style={{ height: "var(--topbar-height)" }}
    >
      {/* Search */}
      <div className="flex flex-1 items-center gap-2 max-w-[380px] rounded-md border border-rule bg-surface-tint px-3 py-1.5 text-[12.5px] text-ink-3">
        <Search size={14} className="text-ink-3" />
        <span className="flex-1 truncate">
          Search orders, cases, SKUs…
        </span>
        <span className="kbd">⌘K</span>
      </div>

      <div className="flex-1" />

      {/* Live pill */}
      <div className="hidden items-center gap-1.5 rounded-md bg-green-soft px-2.5 py-1 text-[11px] font-medium text-green-ink sm:inline-flex">
        <span className="live-dot" />
        <span>5 stores live</span>
      </div>

      {/* Notifications */}
      <button className="grid h-8 w-8 place-items-center rounded-md text-ink-2 hover:bg-bg-elev hover:text-ink">
        <Bell size={16} />
      </button>

      {/* User chip */}
      {me && mounted && (
        <div className="flex items-center gap-2 rounded-full border border-rule bg-surface-tint pr-3">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-green text-[11px] font-semibold text-green-cream">
            {initials}
          </div>
          <div className="hidden flex-col leading-tight sm:flex">
            <div className="flex items-center gap-1 text-[12px] font-medium text-ink">
              {me.displayName || me.username}
              {me.role === "admin" && (
                <ShieldCheck size={11} className="text-green" />
              )}
            </div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            className="grid h-7 w-7 place-items-center rounded-full text-ink-3 hover:text-ink"
          >
            <LogOut size={13} />
          </button>
        </div>
      )}
    </header>
  );
}
