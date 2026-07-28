"use client";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useMobileNav } from "@/lib/mobile-nav-context";
import SidebarContent from "./SidebarContent";

export default function MobileNav() {
  const { open, setOpen } = useMobileNav();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        // Override default w-3/4 sm:max-w-sm — sidebar narrower, comfortable
        // on iPhone SE (375px) without dominating the viewport.
        className="w-[280px] !max-w-[280px] p-0 bg-surface"
      >
        {/* Visually-hidden title for a11y — required by Radix/base-ui Dialog */}
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">
          Main navigation menu
        </SheetDescription>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
