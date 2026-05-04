"use client";

import { useEffect, useState } from "react";

/**
 * Lightweight pull-to-refresh for pages mounted inside `<main className="overflow-auto">`.
 *
 * Behaviour:
 *   - Only fires when the user is already at the top of the scroll container
 *     (otherwise normal vertical scrolling wins).
 *   - Returns `pullDistance` in px — the page can render an indicator that
 *     animates with the gesture (e.g. fading-in spinner).
 *   - On release, if pulled past `threshold` (default 80px), invokes
 *     `onRefresh()` once.
 *
 * Why a custom hook rather than CSS `overscroll-behavior: contain` + native
 * iOS PTR: AppShell sets `overflow-hidden` on body, which kills iOS's native
 * pull. So we reimplement minimally.
 */
export function usePullToRefresh(
  onRefresh: () => void,
  threshold = 80
): number {
  const [pullDistance, setPullDistance] = useState(0);

  useEffect(() => {
    // The scroll container is the <main> with overflow-auto inside AppShell.
    // We detect its scrollTop to know if the user is at the top.
    const findContainer = (): HTMLElement | null => {
      const candidate = document.querySelector(
        "main.overflow-auto"
      ) as HTMLElement | null;
      return candidate;
    };

    let startY = 0;
    let active = false;
    let triggered = false;

    const onTouchStart = (e: TouchEvent) => {
      const c = findContainer();
      if (!c || c.scrollTop > 0) {
        active = false;
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      startY = t.clientY;
      active = true;
      triggered = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      if (dy > 0) {
        // Soft easing — pull feels heavier the further you go.
        const eased = Math.min(120, Math.sqrt(dy * 60));
        setPullDistance(eased);
      } else if (dy < -10) {
        // User reversed direction — let normal scrolling resume.
        active = false;
        setPullDistance(0);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      if (!t) {
        setPullDistance(0);
        return;
      }
      const dy = t.clientY - startY;
      const eased = Math.min(120, Math.sqrt(dy * 60));
      setPullDistance(0);
      if (eased >= threshold && !triggered) {
        triggered = true;
        onRefresh();
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [onRefresh, threshold]);

  return pullDistance;
}
