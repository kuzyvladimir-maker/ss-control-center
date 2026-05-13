"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Menu, Search, ShieldCheck } from "lucide-react";
import { CriticalAlertsBell } from "@/components/critical-alerts/CriticalAlertsBell";
import { useMounted } from "@/lib/use-mounted";
import { useMobileNav } from "@/lib/mobile-nav-context";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { cn } from "@/lib/utils";

interface MeUser {
  username: string;
  displayName: string | null;
  role: string;
}

export default function Header() {
  const router = useRouter();
  const mounted = useMounted();
  const [me, setMe] = useState<MeUser | null>(null);
  const { setOpen: setMobileNavOpen } = useMobileNav();

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
      className="flex shrink-0 items-center gap-2 border-b border-rule bg-surface px-3 md:gap-3 md:px-6"
      style={{ height: "var(--topbar-height)" }}
    >
      {/* Hamburger (mobile only) — opens the drawer. Visible border + tinted
          bg so it reads as a tappable button on light header background. */}
      <button
        type="button"
        onClick={() => setMobileNavOpen(true)}
        aria-label="Открыть меню"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-rule bg-surface-tint text-ink hover:bg-bg-elev md:hidden"
      >
        <Menu size={20} strokeWidth={2.2} />
      </button>

      {/* Search bar (desktop only) */}
      <div className="hidden md:flex flex-1 items-center gap-2 max-w-[380px] rounded-md border border-rule bg-surface-tint px-3 py-1.5 text-[12.5px] text-ink-3">
        <Search size={14} className="text-ink-3" />
        <span className="flex-1 truncate">
          Search orders, cases, SKUs…
        </span>
        <span className="kbd">⌘K</span>
      </div>

      {/* Search icon button (mobile only) — full search UX is Phase 2 */}
      <button
        type="button"
        aria-label="Search"
        className="grid h-9 w-9 place-items-center rounded-md text-ink-2 hover:bg-bg-elev hover:text-ink md:hidden"
      >
        <Search size={18} />
      </button>

      <div className="flex-1" />

      {/* Live pill — reflects the global store filter selection */}
      <StoresLiveBadge />

      {/* Critical alerts feed — polls /api/alerts/unacknowledged */}
      <CriticalAlertsBell />

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
            type="button"
            title="Sign out"
            aria-label="Sign out"
            className="grid h-7 w-7 place-items-center rounded-full text-ink-3 hover:text-ink"
          >
            <LogOut size={13} />
          </button>
        </div>
      )}
    </header>
  );
}

function StoresLiveBadge() {
  const { selectedStoreIds, allStores, isAllSelected, isLoading } =
    useStoreFilter();

  if (isLoading || allStores.length === 0) return null;

  const noSelection = selectedStoreIds.length === 0;
  const label = noSelection
    ? "No stores selected"
    : isAllSelected
      ? `All ${allStores.length} stores live`
      : `${selectedStoreIds.length} of ${allStores.length} stores`;

  return (
    <div
      className={cn(
        "hidden items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium sm:inline-flex",
        noSelection
          ? "bg-bg-elev text-ink-3"
          : "bg-green-soft text-green-ink"
      )}
    >
      <span className={cn("live-dot", noSelection && "opacity-30")} />
      <span className="tabular">{label}</span>
    </div>
  );
}
