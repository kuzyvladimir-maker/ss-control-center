"use client";

/**
 * Client-side authorization guard — the belt-and-suspenders layer behind the
 * Edge proxy. Once `/api/auth/me` resolves, if the current user's role can't
 * open the current path's module, it redirects to /no-access instead of
 * letting the forbidden page render.
 *
 * The proxy already hard-blocks direct navigations (when the access cookie is
 * present); this guard covers the brief window right after login before that
 * cookie is minted, and keeps the decision in sync with fresh DB state.
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { canAccessPath } from "@/lib/rbac/access";
import { useMe } from "@/lib/auth/use-me";

export default function AccessGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useMe();

  const denied =
    !loading &&
    user !== null &&
    !canAccessPath({ role: user.role, modules: user.modules }, pathname);

  useEffect(() => {
    if (denied) {
      router.replace(`/no-access?from=${encodeURIComponent(pathname)}`);
    }
  }, [denied, pathname, router]);

  // Don't paint the forbidden page while the redirect is in flight.
  if (denied) return null;

  return <>{children}</>;
}
