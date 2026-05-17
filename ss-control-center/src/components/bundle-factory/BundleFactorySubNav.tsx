/**
 * Secondary navigation for the Bundle Factory section.
 *
 * Pure design-system styling — no shadcn defaults. Active item uses
 * green-soft + green-ink (Salutem token), inactive items ink-2 with
 * bg-elev hover. Horizontal scroll on mobile so 380px iPhones don't
 * clip tabs.
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
  { href: "/bundle-factory/briefs", label: "Briefs" },
  { href: "/bundle-factory/drafts", label: "Drafts" },
  { href: "/bundle-factory/master-bundles", label: "Master Bundles" },
  { href: "/bundle-factory/live", label: "Live SKUs" },
  { href: "/bundle-factory/stores", label: "Stores" },
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
              "inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-[12.5px] font-medium transition-colors",
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
