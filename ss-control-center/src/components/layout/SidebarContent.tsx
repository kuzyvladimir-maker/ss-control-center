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
  TrendingUp,
  Package,
  ShoppingCart,
  Layers,
  Sprout,
  Leaf,
  BookOpen,
  Sparkles,
  DollarSign,
  PiggyBank,
  Wallet,
  Users,
  GraduationCap,
  BarChart3,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { StoreFilterSelector } from "@/components/layout/StoreFilterSelector";
import { useMe } from "@/lib/auth/use-me";
import { canAccessModule } from "@/lib/rbac/access";
import { moduleForPath } from "@/lib/rbac/modules";

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  pillCount?: number;
  pillVariant?: "active" | "warn";
  disabled?: boolean;
  /** Settings — only visible to admins (sits in the Communications division). */
  adminOnly?: boolean;
}

/**
 * A "division" is one of L. Ron Hubbard's seven org-board divisions. The whole
 * sidebar is grouped this way (variant "Канон" approved by Vladimir 2026-06-21).
 * Order top→bottom follows the org board's particle flow: 7 → 1 → 2 → 3 → 4 → 5 → 6.
 * `num` = division number, `color` = its official org-board color (muted to brand),
 * used for the left accent stripe + number badge. Full module→division mapping lives
 * in docs/wiki/lrh-green-volumes/command-center-orgboard.md.
 */
interface Division {
  num: string;
  name: string;
  color: string;
  items: NavItem[];
}

interface DashboardSummary {
  orders?: { awaitingShipment?: number };
  customerService?: { openCases?: number };
  claims?: { active?: number };
  health?: { issues?: number };
  walmart?: { healthIssues?: number };
  procurement?: { ordersToBuy?: number };
  adjustments?: { monthlyTotal?: number; unreviewed?: number };
}

// Module placement per Vladimir's 2026-06-21 decisions:
//  - Frozen analytics, Adjustments, Account Health → Div 5 (Qualifications)
//  - Sales overview → Div 3 (Treasury)
const divisions = (s: DashboardSummary): Division[] => [
  {
    num: "7",
    name: "Executive",
    color: "#3F6FA0",
    items: [{ title: "Dashboard", href: "/", icon: LayoutDashboard }],
  },
  {
    num: "1",
    name: "Communications",
    color: "#B8901F",
    items: [
      { title: "Reference Catalog", href: "/reference-catalog", icon: BookOpen },
      // Staff directory + "hats" (post write-ups / job descriptions), digitized
      // from the Google Drive "Должностные инструкции" folder.
      { title: "Staff Hats", href: "/staff-hats", icon: Users },
      // Planned (Vladimir 2026-06-21): org statistics — every division & key
      // process has a stat, entered/graphed weekly, conditions assigned from
      // trends. Org-board home = HCO Dept 3 (Inspections & Reports) = Div 1.
      // Distinct from Dashboard (Div 7), which is the executive view that
      // consumes these stats.
      { title: "Statistics", href: "/statistics", icon: BarChart3, disabled: true },
    ],
  },
  {
    num: "2",
    name: "Dissemination",
    color: "#6B5A8C",
    items: [
      { title: "Amazon Growth", href: "/amazon-growth", icon: Leaf },
      { title: "Walmart Growth", href: "/walmart-growth", icon: Sprout },
      { title: "A+ Content", href: "/amazon-aplus", icon: Sparkles },
      { title: "Bundle Factory", href: "/bundle-factory", icon: Layers },
    ],
  },
  {
    num: "3",
    name: "Treasury",
    color: "#A85C73",
    items: [
      { title: "Financial Plan", href: "/finance", icon: PiggyBank },
      // Owner-only personal finance (income, bills, credit cards). adminOnly →
      // only the admin/owner sees and can open it (see RBAC `personal` module).
      { title: "Personal Finance", href: "/personal", icon: Wallet, adminOnly: true },
      { title: "Economics", href: "/economics", icon: DollarSign },
      { title: "Sales overview", href: "/analytics", icon: TrendingUp },
    ],
  },
  {
    num: "4",
    name: "Production",
    color: "#1F4D3F",
    items: [
      {
        title: "Procurement",
        href: "/procurement",
        icon: ShoppingCart,
        pillCount: s.procurement?.ordersToBuy || undefined,
        pillVariant: "active",
      },
      { title: "Suppliers", href: "/suppliers", icon: Package, disabled: true },
      {
        title: "Shipping labels",
        href: "/shipping",
        icon: Truck,
        pillCount: s.orders?.awaitingShipment || undefined,
        pillVariant: "active",
      },
    ],
  },
  {
    num: "5",
    name: "Qualifications",
    color: "#7D827D",
    items: [
      {
        title: "Account Health",
        href: "/account-health",
        icon: HeartPulse,
        pillCount:
          (s.health?.issues ?? 0) + (s.walmart?.healthIssues ?? 0) || undefined,
        pillVariant: "warn",
      },
      { title: "Frozen analytics", href: "/frozen-analytics", icon: Thermometer },
      {
        title: "Adjustments",
        href: "/adjustments",
        icon: Receipt,
        // Unreviewed shipping adjustments (30d). NOT s.claims.active — that's
        // the A-to-Z claim queue, a different number.
        pillCount: s.adjustments?.unreviewed || undefined,
        pillVariant: "warn",
      },
      // Staff training courses + per-browser completion tracking, digitized
      // from Vladimir's existing Google Drive courses.
      { title: "Training", href: "/training", icon: GraduationCap },
    ],
  },
  {
    num: "6",
    name: "Public",
    color: "#9A6B1C",
    items: [
      {
        title: "Customer hub",
        href: "/customer-hub",
        icon: MessageSquare,
        pillCount: s.customerService?.openCases || undefined,
        pillVariant: "active",
      },
    ],
  },
];

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
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
    <Link href={item.href} className={className} onClick={onNavigate}>
      {content}
    </Link>
  );
}

/** One collapsible org-board division block (colored stripe + number badge + items). */
function DivisionBlock({
  div,
  visibleItems,
  collapsed,
  onToggle,
  isActive,
  onNavigate,
}: {
  div: Division;
  visibleItems: NavItem[];
  collapsed: boolean;
  onToggle: () => void;
  isActive: (href: string) => boolean;
  onNavigate?: () => void;
}) {
  if (visibleItems.length === 0) return null;
  return (
    <div
      className="mb-1.5 rounded-r-lg bg-surface-tint"
      style={{ borderLeft: `3px solid ${div.color}` }}
    >
      {/* Header — click anywhere to collapse/expand */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5"
        aria-expanded={!collapsed}
      >
        <span
          className="grid h-[17px] min-w-[17px] place-items-center rounded font-mono text-[10px] font-semibold text-white"
          style={{ background: div.color }}
        >
          {div.num}
        </span>
        <span className="flex-1 text-left font-mono text-[9.5px] font-medium uppercase tracking-[0.1em] text-ink-2">
          {div.name}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={1.8}
          className={cn(
            "text-ink-4 transition-transform",
            collapsed && "-rotate-90"
          )}
        />
      </button>

      {!collapsed && (
        <nav className="space-y-0.5 px-1 pb-1.5">
          {visibleItems.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={!item.disabled && isActive(item.href)}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      )}
    </div>
  );
}

export default function SidebarContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { user } = useMe();
  const [summary, setSummary] = useState<DashboardSummary>({});
  // Which division numbers are collapsed. Empty = all expanded. Kept in memory:
  // it survives client-side navigation (this component stays mounted in the
  // layout) and resets only on a full page reload.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleDiv = (num: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  };

  // Show a nav item only if the user's role may open its module. Always-on
  // modules (Dashboard) and non-module paths stay visible; while `/api/auth/me`
  // is still loading (user === null) we show only always-on items so forbidden
  // links never flash in.
  const canSee = (href: string): boolean => {
    const mod = moduleForPath(href);
    if (!mod || mod.alwaysOn) return true;
    if (!user) return false;
    return canAccessModule({ role: user.role, modules: user.modules }, mod.key);
  };

  // Decide which items in a division this user may see:
  //  - disabled (Phase 2 teasers) always show, as "Soon"
  //  - adminOnly (Settings) only for admins
  //  - everything else gated by RBAC module access
  const visibleItemsFor = (div: Division): NavItem[] =>
    div.items.filter((item) => {
      if (item.disabled) return true;
      if (item.adminOnly) return !!user?.isAdmin;
      return canSee(item.href);
    });

  useEffect(() => {
    let cancelled = false;
    // Two parallel fetches:
    //   1. /api/dashboard/summary — fast, reads counts from our DB.
    //   2. /api/shipping/dashboard — slow, live-fetches Veeqo, used ONLY to
    //      override the shipping-labels count so the sidebar matches the
    //      Shipping Labels page ("Awaiting fulfillment").
    const load = async () => {
      try {
        const [summaryRes, shippingRes] = await Promise.all([
          fetch("/api/dashboard/summary"),
          fetch("/api/shipping/dashboard"),
        ]);
        if (cancelled) return;
        const summaryJson: DashboardSummary | null = summaryRes.ok
          ? await summaryRes.json()
          : null;
        const shippingJson: { orders?: unknown[] } | null = shippingRes.ok
          ? await shippingRes.json()
          : null;
        if (cancelled) return;
        const liveShippingCount = Array.isArray(shippingJson?.orders)
          ? shippingJson.orders.length
          : undefined;
        setSummary({
          ...(summaryJson ?? {}),
          orders: {
            ...(summaryJson?.orders ?? {}),
            awaitingShipment:
              liveShippingCount ?? summaryJson?.orders?.awaitingShipment,
          },
        });
      } catch {
        /* sidebar refresh is best-effort */
      }
    };
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
    <div className="flex h-full flex-col">
      {/* Brand block */}
      <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3.5">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-green text-green-cream font-semibold">
          S
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold text-ink">Salutem</div>
          <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3">
            Command Center
          </div>
        </div>
      </div>

      {/* Global store filter — drives all Dashboard data. */}
      <div className="mx-3 mt-3">
        <StoreFilterSelector />
      </div>

      {/* Org-board divisions (7 → 1 → 2 → 3 → 4 → 5 → 6), each collapsible. */}
      <div className="mt-3 flex-1 space-y-0 overflow-y-auto px-2 pb-3">
        {divisions(summary).map((div) => (
          <DivisionBlock
            key={div.num}
            div={div}
            visibleItems={visibleItemsFor(div)}
            collapsed={collapsed.has(div.num)}
            onToggle={() => toggleDiv(div.num)}
            isActive={isActive}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
