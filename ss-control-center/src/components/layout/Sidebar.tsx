"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  HeartPulse,
  Truck,
  MessageSquare,
  Scale,
  Star,
  Thermometer,
  Receipt,
  Tags,
  DollarSign,
  ShoppingCart,
  Megaphone,
  RefreshCw,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState } from "react";

const navItems = [
  { title: "Dashboard", href: "/", icon: LayoutDashboard },
  { title: "Account Health", href: "/account-health", icon: HeartPulse },
  { title: "Shipping Labels", href: "/shipping", icon: Truck },
  { title: "Customer Service", href: "/customer-service", icon: MessageSquare },
  { title: "A-to-Z & Chargebacks", href: "/claims/atoz", icon: Scale },
  { title: "Feedback Manager", href: "/feedback", icon: Star },
  { title: "Frozen Analytics", href: "/frozen-analytics", icon: Thermometer },
  { title: "Adjustments", href: "/adjustments", icon: Receipt },
  { title: "Product Listings", href: "/listings", icon: Tags },
  { title: "Sales Analytics", href: "/analytics", icon: DollarSign },
  { title: "Suppliers", href: "/suppliers", icon: ShoppingCart },
  { title: "Promotions", href: "/promotions", icon: Megaphone },
  { title: "Integrations", href: "/integrations", icon: RefreshCw },
  { title: "Settings", href: "/settings", icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-slate-200 bg-slate-50 transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-slate-200 px-4">
        {!collapsed && (
          <span className="text-sm font-bold text-slate-800 truncate">
            SS Control Center
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "rounded-md p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600",
            collapsed ? "mx-auto" : "ml-auto"
          )}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;

          const linkContent = (
            <div
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              <Icon size={18} />
              {!collapsed && (
                <span className="flex-1 truncate">{item.title}</span>
              )}
            </div>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger>
                  <Link href={item.href}>{linkContent}</Link>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {item.title}
                </TooltipContent>
              </Tooltip>
            );
          }

          return (
            <Link key={item.href} href={item.href}>
              {linkContent}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
