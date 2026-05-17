/**
 * Bundle Factory sub-layout.
 *
 * Wraps every /bundle-factory/* page with the section's secondary nav.
 * Sub-nav is a row of pill-tabs styled per Salutem Design System v1.0
 * (green-soft active state, ink-2 inactive). Layout stays inside the
 * AppShell so the global sidebar + topbar remain visible.
 */

import type { ReactNode } from "react";
import { BundleFactorySubNav } from "@/components/bundle-factory/BundleFactorySubNav";

export default function BundleFactoryLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <BundleFactorySubNav />
      {children}
    </div>
  );
}
