/**
 * RBAC module registry — the single source of truth for "what modules
 * exist" and "what key identifies each one".
 *
 * A role's permissions are simply a list of module `key`s it may open.
 * Everything else (sidebar filtering, the proxy URL gate, the per-route
 * data guard, and the Roles management UI) derives the set of modules
 * from THIS file so they never drift apart.
 *
 * Keep this in sync with the sidebar nav in
 * `src/components/layout/SidebarContent.tsx` — same `href`s, same order.
 */

export interface ModuleDef {
  /** Stable identifier used in Role.modules and access checks. */
  key: string;
  /** Human label shown in the Roles permission grid. */
  label: string;
  /** Route prefix this module owns. Used to map a URL → module. */
  href: string;
  /**
   * `alwaysOn` modules are visible to every authenticated user regardless
   * of role (e.g. the Dashboard / landing page). They are never shown as a
   * grantable permission in the Roles UI.
   */
  alwaysOn?: boolean;
  /**
   * `adminOnly` modules are reachable only by the built-in `admin` role and
   * are never grantable to custom roles (e.g. Settings, where roles are
   * managed). Kept in the registry so the URL gate knows about them.
   */
  adminOnly?: boolean;
}

/**
 * Order matters for two reasons:
 *   1. It's the display order in the Roles permission grid.
 *   2. `moduleForPath` matches by LONGEST href first (see below), so a more
 *      specific prefix wins over a shorter one if they ever overlap.
 */
export const MODULES: ModuleDef[] = [
  { key: "dashboard", label: "Dashboard", href: "/", alwaysOn: true },
  { key: "analytics", label: "Sales overview", href: "/analytics" },
  { key: "account-health", label: "Account Health", href: "/account-health" },
  { key: "procurement", label: "Procurement", href: "/procurement" },
  { key: "shipping", label: "Shipping labels", href: "/shipping" },
  { key: "customer-hub", label: "Customer hub", href: "/customer-hub" },
  { key: "frozen-analytics", label: "Frozen analytics", href: "/frozen-analytics" },
  { key: "adjustments", label: "Adjustments", href: "/adjustments" },
  { key: "training", label: "Training", href: "/training" },
  { key: "bundle-factory", label: "Bundle Factory", href: "/bundle-factory" },
  { key: "reference-catalog", label: "Reference Catalog", href: "/reference-catalog" },
  { key: "staff-hats", label: "Staff Hats", href: "/staff-hats" },
  { key: "finance", label: "Financial Plan", href: "/finance" },
  { key: "economics", label: "Economics", href: "/economics" },
  { key: "walmart-growth", label: "Walmart Growth", href: "/walmart-growth" },
  { key: "amazon-growth", label: "Amazon Growth", href: "/amazon-growth" },
  { key: "amazon-aplus", label: "A+ Content", href: "/amazon-aplus" },
  { key: "settings", label: "Settings", href: "/settings", adminOnly: true },
];

/** Every module key (including alwaysOn / adminOnly). */
export const ALL_MODULE_KEYS: string[] = MODULES.map((m) => m.key);

/**
 * Modules an admin can hand to a custom role — excludes alwaysOn (free for
 * everyone) and adminOnly (admin-reserved). This is what the Roles UI shows
 * as checkboxes and what `member`/custom roles are seeded with.
 */
export const GRANTABLE_MODULES: ModuleDef[] = MODULES.filter(
  (m) => !m.alwaysOn && !m.adminOnly
);

export const GRANTABLE_MODULE_KEYS: string[] = GRANTABLE_MODULES.map(
  (m) => m.key
);

const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key: string): ModuleDef | undefined {
  return MODULE_BY_KEY.get(key);
}

/**
 * Resolve a pathname to the module that owns it, or `null` for paths that
 * aren't gated by a module (e.g. `/login`, `/api/...`, static assets).
 *
 * Matching is by longest `href` prefix so `/account-health` beats `/` and a
 * future `/finance/funds` still resolves to the `finance` module. The root
 * Dashboard (`href: "/"`) only matches the exact `/` path.
 */
export function moduleForPath(pathname: string): ModuleDef | null {
  // Normalise trailing slash (except root).
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  let best: ModuleDef | null = null;
  for (const m of MODULES) {
    if (m.href === "/") {
      if (path === "/") return m; // home is exact-match only
      continue;
    }
    if (path === m.href || path.startsWith(m.href + "/")) {
      if (!best || m.href.length > best.href.length) best = m;
    }
  }
  return best;
}
