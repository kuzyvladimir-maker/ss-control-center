"use client";

/**
 * Shared tab bar for the ONE "Catalog" module. The catalog has three sub-views —
 * Overview (status/progress), Cost (COGS), and Content (reference/donor) — but ONE
 * sidebar entry. This bar (rendered at the top of each sub-page) is how they read as
 * a single module with sub-catalogs, per Vladimir's "don't proliferate catalogs".
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, DollarSign, Database } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/catalog", label: "Overview", icon: BarChart3, hint: "Progress & status" },
  { href: "/cogs", label: "Cost", icon: DollarSign, hint: "True cost per SKU" },
  { href: "/reference-catalog", label: "Content", icon: Database, hint: "Donor products for listings" },
];

export function CatalogTabs() {
  const pathname = usePathname() || "";
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-rule">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            title={t.hint}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition",
              active
                ? "border-green text-green-ink"
                : "border-transparent text-ink-3 hover:text-ink hover:border-rule",
            )}
          >
            <Icon size={14} />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
