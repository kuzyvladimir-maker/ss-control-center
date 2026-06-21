/**
 * Pure RBAC decision logic — no Node, no React, no DB. Safe to import from
 * the server (API routes), the Edge proxy (`proxy.ts`), and the client
 * (sidebar / AccessGuard) alike.
 *
 * A user's effective access is described by an `AccessContext`:
 *   - `role`   — the role key (e.g. "admin", "member", or a custom one)
 *   - `modules`— the module keys this role may open
 *
 * The built-in `admin` role bypasses every check.
 */

import { MODULES, getModule, moduleForPath, type ModuleDef } from "./modules";

export const ADMIN_ROLE = "admin";

export interface AccessContext {
  role: string;
  /** Module keys granted to this user's role (excludes alwaysOn freebies). */
  modules: string[];
}

export function isAdmin(ctx: Pick<AccessContext, "role">): boolean {
  return ctx.role === ADMIN_ROLE;
}

/** Can this user open the given module key? */
export function canAccessModule(ctx: AccessContext, key: string): boolean {
  if (isAdmin(ctx)) return true;
  const mod = getModule(key);
  if (!mod) return false; // unknown module → deny by default
  if (mod.alwaysOn) return true; // e.g. Dashboard
  if (mod.adminOnly) return false; // admin already returned true above
  return ctx.modules.includes(key);
}

/**
 * Can this user open the given URL path? Paths that don't belong to any
 * module (`/login`, `/api/...`, `/no-access`, static) are NOT gated here and
 * return `true` — the proxy handles the auth gate for those separately.
 */
export function canAccessPath(ctx: AccessContext, pathname: string): boolean {
  const mod = moduleForPath(pathname);
  if (!mod) return true;
  return canAccessModule(ctx, mod.key);
}

/** The subset of module DEFS this user may see — for sidebar rendering. */
export function accessibleModules(ctx: AccessContext): ModuleDef[] {
  return MODULES.filter((m) => canAccessModule(ctx, m.key));
}

/**
 * Maps an `/api/...` path to the module that owns its DATA, for the proxy's
 * API module-gate. ONLY lists prefixes that are exclusively owned by one
 * module — verified to have no cross-module callers. Shared API areas
 * (`/api/dashboard`, `/api/veeqo`, `/api/amazon`, `/api/walmart`, `/api/stores`,
 * etc.) and modules whose data is surfaced on shared pages (shipping →
 * sidebar, frozen → Shipping page, customer-hub → home Dashboard) are
 * deliberately omitted so gating never breaks a page a user IS allowed to see.
 * Those stay protected at the session level (any signed-in user).
 *
 * Order: longer/more-specific prefixes first.
 */
const API_MODULE_PREFIXES: Array<[string, string]> = [
  ["/api/finance", "finance"],
  ["/api/economics", "economics"],
  ["/api/adjustments", "adjustments"],
  ["/api/procurement", "procurement"],
  ["/api/bundle-factory", "bundle-factory"],
  ["/api/reference-catalog", "reference-catalog"],
  ["/api/account-health", "account-health"],
  ["/api/sales-overview", "analytics"],
  ["/api/analytics", "analytics"],
];

/** The module key that owns this API path, or null if it isn't module-gated. */
export function moduleKeyForApiPath(pathname: string): string | null {
  for (const [prefix, key] of API_MODULE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return key;
  }
  return null;
}

/** Normalise an unknown DB value into a clean string[] of module keys. */
export function parseModules(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // fall through — treat as comma-separated legacy value
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}
