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
  2. **Proxy** (`src/proxy.ts`) redirects a direct URL hit to `/no-access`.
  3. **Server** (`requireModuleAccess`) — available to gate a module's API data
     (see "Phase C" below).

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

## Phase C — per-module API data protection (TODO, coordinate)

The proxy already gates **pages** by module and **all `/api`** by session
(any logged-in user). What's **not** yet enforced: a logged-in user whose role
lacks a module could still call that module's data API directly. To close it,
drop `requireModuleAccess(request, "<moduleKey>")` at the top of each module's
API route handlers. Deferred deliberately — it's the broadest surface and
several modules are under active parallel development; do it per-module to avoid
churn.

See also: [[wiki-brain-system]], CLAUDE.md (accounts/auth notes).
