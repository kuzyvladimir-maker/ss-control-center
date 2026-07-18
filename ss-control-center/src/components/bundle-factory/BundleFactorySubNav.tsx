/**
 * Secondary navigation for the Bundle Factory section.
 *
 * Phase 7: trimmed to the simple operator path — Overview (create) ·
 * In progress · Published · ChannelMAX · Settings. The advanced/internal pages
 * (Master Bundles, Audit, Compliance, Stores, Briefs) still exist by URL
 * and are linked from the Overview "At a glance" strip; they're kept out
 * of the top nav so the section reads as one straight flow.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type SubNavItem = {
  href: string;
  label: string;
};

const ITEMS: SubNavItem[] = [
  { href: "/bundle-factory", label: "Overview" },
  { href: "/bundle-factory/drafts", label: "In progress" },
  { href: "/bundle-factory/live", label: "Published" },
  { href: "/bundle-factory/channelmax", label: "ChannelMAX" },
  { href: "/bundle-factory/settings", label: "Settings" },
];

export function BundleFactorySubNav() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === "/bundle-factory") return pathname === "/bundle-factory";
    return pathname.startsWith(href);
  }

  return (
    <nav
      aria-label="Bundle Factory sections"
      className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {ITEMS.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors",
              active
                ? "border-green-soft2 bg-green-soft text-green-ink"
                : "border-rule bg-surface text-ink-2 hover:bg-bg-elev hover:text-ink"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
