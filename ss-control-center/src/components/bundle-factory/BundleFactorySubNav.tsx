/**
 * Secondary navigation for the Bundle Factory section.
 *
 * Pure design-system styling — no shadcn defaults. Active item uses
 * green-soft + green-ink (Salutem token), inactive items ink-2 with
 * bg-elev hover. Horizontal scroll on mobile so 380px iPhones don't
 * clip tabs.
 */

"use client";

import { useEffect, useState } from "react";
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
  { href: "/bundle-factory/audit", label: "Audit" },
  { href: "/bundle-factory/compliance", label: "Compliance" },
  { href: "/bundle-factory/stores", label: "Stores" },
  { href: "/bundle-factory/settings", label: "Settings" },
];

export function BundleFactorySubNav() {
  const pathname = usePathname();
  // Live BLOCKED-count badge on the Audit tab — pulled from the most
  // recent completed scan once on mount. Refresh only happens on page
  // navigation, not via polling, to keep the topbar cheap.
  const [blockedCount, setBlockedCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          "/api/bundle-factory/audit/scans?status=completed&limit=1",
        );
        if (!r.ok) return;
        const { scans } = (await r.json()) as {
          scans: Array<{ blocked_count: number }>;
        };
        if (!cancelled && scans.length > 0) {
          setBlockedCount(scans[0].blocked_count);
        }
      } catch {
        /* swallow — badge stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        const showBadge =
          item.href === "/bundle-factory/audit" &&
          blockedCount != null &&
          blockedCount > 0;
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
            {showBadge && (
              <span
                aria-label={`${blockedCount} blocked listings`}
                className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-semibold leading-none text-cream"
              >
                {blockedCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
