"use client";

import SidebarContent from "./SidebarContent";

/**
 * Desktop sidebar — visible at md+ breakpoint, fully hidden on mobile
 * (doesn't even occupy flex space). On mobile the same content is
 * rendered inside `<MobileNav />` as a drawer.
 */
export default function Sidebar() {
  return (
    <aside
      className="hidden md:flex h-screen flex-col border-r border-rule bg-surface"
      style={{ width: "var(--sidebar-width)" }}
    >
      <SidebarContent />
    </aside>
  );
}
