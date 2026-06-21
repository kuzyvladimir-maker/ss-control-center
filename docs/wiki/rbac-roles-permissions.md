# RBAC — Roles & per-module permissions

**Added:** 2026-06-21. Multi-user access control: custom roles, each granted a
set of modules, invite-only entry, Settings reserved for admins.

## What it does

- **Invite-only access** (already existed): you can only get an account from an
  admin-issued invite link. The proxy redirects every unauthenticated page
  request to `/login`.
- **Custom roles** (new): the admin creates roles (e.g. "Procurement",
  "Customer Service") and ticks which modules each role may open.
- **Hard enforcement on three layers** for non-permitted modules:
  1. **Sidebar** hides modules the role can't open; **Settings** link shows for
     admins only.
  2. **Proxy** (`src/proxy.ts`) redirects a direct URL hit to `/no-access`, and
     returns 403 on the module's own data APIs (see "API data gate" below).
  3. **Client** `AccessGuard` re-checks against fresh `/api/auth/me` state.

## Model

`Role` table (`prisma/schema.prisma`): `key` (referenced by `User.role` /
`Invite.role`), `name`, `modules` (JSON array of module keys), `isSystem`.
`User.role` / `Invite.role` are plain strings holding a role `key`, so adding
roles never touches the User/Invite models.

Two seeded system roles (can't be deleted/renamed):
- **admin** — bypasses every check, sees all modules incl. Settings.
- **member** — seeded with *all* grantable modules so existing users keep their
  access; tighten by creating narrower custom roles.

The canonical module list lives in [`src/lib/rbac/modules.ts`](../../ss-control-center/src/lib/rbac/modules.ts)
(`MODULES`) — keep it in sync with the sidebar nav. `dashboard` is always-on;
`settings` is admin-only; the other 14 are grantable.

## Key files

| File | Role |
|------|------|
| `src/lib/rbac/modules.ts` | Module registry + `moduleForPath()` |
| `src/lib/rbac/access.ts` | Pure decision logic (`canAccessModule/Path`) — safe in Edge/client |
| `src/lib/rbac/access-cookie.ts` | Sign/verify the `sscc-access` cookie the proxy reads |
| `src/lib/auth-server.ts` | `getCurrentUserWithAccess`, `requireModuleAccess`, `attachAccessCookie` |
| `src/proxy.ts` | Auth gate (orig.) + page module gate (new) |
| `src/app/api/admin/roles/*` | Role CRUD (admin) |
| `src/app/api/rbac/modules` | Grantable module list for the Roles UI |
| `src/app/settings/roles/page.tsx` | Roles management UI |
| `src/lib/auth/use-me.tsx` | `MeProvider`/`useMe` — one `/api/auth/me` for the shell |
| `src/components/layout/AccessGuard.tsx` | Client belt-and-suspenders gate |
| `src/app/no-access/page.tsx` | Friendly "access restricted" page |

## How the access cookie works

`/api/auth/me`, login, and invite-accept stamp a signed `sscc-access` cookie
(`{user, role, modules}`, HMAC-SHA256 with `NEXTAUTH_SECRET` — same scheme as
the session token). The Edge proxy reads it to gate pages **without a DB
round-trip**. It's *optimistic*: it can lag a role edit by one navigation, so
the server (`requireModuleAccess`) and client (`AccessGuard`) remain
authoritative. `/api/auth/me` refreshes it on every page load, so it self-heals.

## Migration

`prisma/migrations/20260621000000_rbac_roles/` + idempotent applier
`scripts/migrate-rbac-roles.mjs` (run with `node -r dotenv/config`). Applied to
Turso (prod, what the app uses) + local `dev.db` files. Re-runnable safely.

## API data gate (per-module)

The proxy also returns **403** when a role hits the data API of a module it
can't open. This is done centrally in `src/proxy.ts` via
`moduleKeyForApiPath()` (in `access.ts`) — a curated map of `/api/...` prefixes
that are **exclusively owned by one module** (verified to have no
cross-module callers): `finance`, `economics`, `adjustments`, `procurement`,
`bundle-factory`, `reference-catalog`, `account-health`, `analytics` +
`sales-overview`.

**Intentionally session-only (not module-gated), to avoid breaking shared
pages:**
- `shipping` — its `/api/shipping/dashboard` is polled by the sidebar for
  everyone.
- `frozen` — surfaced on the Shipping page (`FrozenRiskBadge`).
- `customer-hub` (+`claims`/`feedback`) — surfaced on the home Dashboard.
- `walmart-growth` / `amazon-growth` / `amazon-aplus` — ride shared
  `/api/walmart` · `/api/amazon` prefixes with no dedicated, safe-to-gate path.
- Shared infra (`/api/dashboard`, `/api/veeqo`, `/api/stores`, `/api/sync`,
  `/api/integrations`, …) is never gated.

For a stricter, DB-fresh guard on a specific endpoint, `requireModuleAccess`
(in `auth-server.ts`) is available to drop into individual route handlers. The
proxy gate is optimistic (reads the access cookie); machine clients (bearer
token) and crons bypass it because they return earlier in the proxy.

See also: [[wiki-brain-system]], CLAUDE.md (accounts/auth notes).
