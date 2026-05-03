"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  HeartPulse,
  Truck,
  MessageSquare,
  Thermometer,
  Receipt,
  Tags,
  TrendingUp,
  Package,
  Settings,
  ChevronDown,
  ShoppingCart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  pillCount?: number;
  pillVariant?: "active" | "warn";
  disabled?: boolean;
}

interface DashboardSummary {
  orders?: { awaitingShipment?: number };
  customerService?: { openCases?: number };
  claims?: { active?: number };
  health?: { issues?: number };
  walmart?: { healthIssues?: number };
}

const operationsItems = (s: DashboardSummary): NavItem[] => [
  { title: "Dashboard", href: "/", icon: LayoutDashboard },
  {
    title: "Account Health",
    href: "/account-health",
    icon: HeartPulse,
    pillCount:
      (s.health?.issues ?? 0) + (s.walmart?.healthIssues ?? 0) || undefined,
    pillVariant: "warn",
  },
  {
    title: "Procurement",
    href: "/procurement",
    icon: ShoppingCart,
  },
  {
    title: "Shipping labels",
    href: "/shipping",
    icon: Truck,
    pillCount: s.orders?.awaitingShipment || undefined,
    pillVariant: "active",
  },
  {
    title: "Customer hub",
    href: "/customer-hub",
    icon: MessageSquare,
    pillCount: s.customerService?.openCases || undefined,
    pillVariant: "active",
  },
  { title: "Frozen analytics", href: "/frozen-analytics", icon: Thermometer },
  {
    title: "Adjustments",
    href: "/adjustments",
    icon: Receipt,
    pillCount: s.claims?.active || undefined,
    pillVariant: "warn",
  },
];

const phase2Items: NavItem[] = [
  { title: "Product listings", href: "/listings", icon: Tags, disabled: true },
  { title: "Sales overview", href: "/analytics", icon: TrendingUp, disabled: true },
  { title: "Suppliers", href: "/suppliers", icon: Package, disabled: true },
];

const settingsItem: NavItem = {
  title: "Settings",
  href: "/settings",
  icon: Settings,
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  const className = cn(
    "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
    item.disabled
      ? "cursor-not-allowed opacity-50 text-ink-3"
      : active
        ? "bg-green-soft text-green-ink"
        : "text-ink-2 hover:bg-bg-elev hover:text-ink"
  );

  const content = (
    <>
      <Icon size={15} strokeWidth={1.7} />
      <span className="flex-1 truncate">{item.title}</span>
      {item.pillCount !== undefined && (
        <span
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular",
            item.pillVariant === "warn"
              ? "bg-warn-tint text-warn-strong"
              : "bg-green-soft2 text-green-ink"
          )}
        >
          {item.pillCount}
        </span>
      )}
      {item.disabled && (
        <span className="rounded bg-bg-elev px-1.5 py-px text-[9px] font-mono uppercase tracking-wider text-ink-3">
          Soon
        </span>
      )}
    </>
  );

  if (item.disabled) {
    return <div className={className}>{content}</div>;
  }
  return (
    <Link href={item.href} className={className}>
      {content}
    </Link>
  );
}

function NavSection({ label }: { label: string }) {
  return (
    <div className="px-2.5 pb-1.5 pt-3 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3">
      {label}
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [summary, setSummary] = useState<DashboardSummary>({});

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/dashboard/summary")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && !cancelled) setSummary(j);
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside
      className="flex h-screen flex-col border-r border-rule bg-surface"
      style={{ width: "var(--sidebar-width)" }}
    >
      {/* Brand block */}
      <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3.5">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-green text-green-cream font-semibold">
          S
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold text-ink">Salutem</div>
          <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3">
            Control · v1.4
          </div>
        </div>
      </div>

      {/* Workspace switcher (placeholder — real switch later) */}
      <div className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-rule bg-surface-tint px-2.5 py-1.5 text-[12px] text-ink">
        <span className="live-dot" />
        <span className="flex-1">All stores</span>
        <span className="rounded bg-bg-elev px-1.5 text-[10px] font-semibold text-ink-2">
          5
        </span>
        <ChevronDown size={13} className="text-ink-3" />
      </div>

      {/* Operations */}
      <NavSection label="Operations" />
      <nav className="space-y-0.5 px-2">
        {operationsItems(summary).map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      {/* Phase 2 */}
      <NavSection label="Phase 2" />
      <nav className="space-y-0.5 px-2">
        {phase2Items.map((item) => (
          <NavLink key={item.href} item={item} active={false} />
        ))}
      </nav>

      <div className="flex-1" />

      {/* Settings (always at bottom) */}
      <div className="px-2 pb-2">
        <NavLink item={settingsItem} active={isActive("/settings")} />
      </div>

      {/* Helper card */}
      {(summary.orders?.awaitingShipment ?? 0) > 0 && (
        <div className="m-3 rounded-lg border border-rule bg-green-soft px-3 py-2.5 text-green-ink">
          <div className="text-[11px] font-semibold">Daily plan ready</div>
          <div className="mt-0.5 text-[11px] text-green-ink/80 tabular">
            {summary.orders?.awaitingShipment} shipments queued
          </div>
          <Link
            href="/shipping"
            className="mt-2 inline-flex text-[11px] font-medium text-green hover:text-green-deep"
          >
            Continue →
          </Link>
        </div>
      )}
    </aside>
  );
}
