# Claude Code Prompt: SS Command Center Audit Fixes

Project path:

`/Users/vladimirkuznetsov/SS Command Center/ss-control-center`

You are working on a Next.js 16 / React 19 app called SS Command Center.
Make targeted repairs based on the audit below. Avoid broad redesigns or architecture rewrites. Read the nearby code before editing, preserve existing style, and do not touch or commit `.env`.

After changes, run:

```bash
npm run lint
npm run build
```

## 1. Fix Lint Failure

File:

`src/components/kit/PageHead.tsx`

Problem:

`SyncChip` calls `Date.now()` during render, which fails React Compiler lint:

```ts
const minsAgo = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
```

Fix:

- Move current-time calculation out of pure render, for example with `useEffect/useState`.
- Keep current labels:
  - `Synced just now`
  - `Synced Xm ago`
  - `Synced Xh ago`
- Do not break existing `SyncChip` usage.

## 2. Make Navigation Honest

Files:

- `src/components/layout/SidebarContent.tsx`
- `src/app/listings/page.tsx`
- `src/app/suppliers/page.tsx`
- `src/app/promotions/page.tsx`
- `src/app/analytics/page.tsx`

Problems:

- `/listings`, `/suppliers`, and `/promotions` are `ComingSoon`.
- Sidebar disables Product listings, Sales overview, and Suppliers.
- `/analytics` appears to have a real page, but Sales overview is disabled.

Fix:

- If `/analytics` is functional, enable Sales overview in the sidebar.
- Keep true stub pages disabled or clearly marked as coming soon.
- Decide whether `/promotions` should be listed as a disabled Phase 2 item or remain hidden, but make the behavior consistent.
- Do not implement full Listings/Suppliers/Promotions now.

## 3. Fix Seller Feedback Sync UX

File:

`src/app/api/customer-hub/feedback/route.ts`

Problem:

`POST { action: "sync" }` returns a stub:

```ts
{
  synced: 0,
  message: "SP-API Feedback Reports sync coming soon"
}
```

Fix:

- Find the UI that triggers feedback sync.
- Minimum acceptable fix: make the UI honest, for example “coming soon / manual entry only,” so the operator does not think sync is active.
- Better fix, only if existing SP-API report helpers make it straightforward: implement real seller-feedback import.
- Preserve manual feedback creation.

## 4. Unify Walmart Config Status

Files:

- `src/lib/walmart/client.ts`
- `src/app/api/customer-hub/walmart/orders/sync/route.ts`
- `src/app/api/customer-hub/walmart/returns/sync/route.ts`
- `src/app/api/amazon/stores/route.ts`
- `src/app/api/customer-hub/route.ts`
- `src/app/api/integrations/route.ts`

Problem:

The project has a Walmart client and sync routes, but several APIs still hardcode Walmart as placeholder/not configured.

Fix:

- Add a shared helper or consistent logic for Walmart configuration status.
- Treat Walmart store N as configured only when these exist:
  - `WALMART_CLIENT_ID_STORE{N}`
  - `WALMART_CLIENT_SECRET_STORE{N}`
  - `WALMART_STORE{N}_SELLER_ID`
- Use this status in integrations, customer hub, and store APIs.
- Do not hardcode Walmart as `not_configured` when credentials exist.
- Keep graceful behavior when Walmart env vars are absent.

## 5. Fix Google Sheets Configuration Visibility

Files:

- `src/lib/google-sheets.ts`
- `src/app/api/shipping/plan/route.ts`
- `src/app/api/integrations/route.ts`
- `.env.example`

Problem:

`google-sheets.ts` requires `GOOGLE_SHEETS_API_KEY`, but `.env.example` and integrations status mostly check only `GOOGLE_SHEETS_ID`.
If the key is missing, shipping plan continues with an empty SKU database, causing many items to stop for SKU/weight/dimension reasons.

Fix:

- Add `GOOGLE_SHEETS_API_KEY=` to `.env.example`.
- Update `/api/integrations` so Google Sheets is connected only when both `GOOGLE_SHEETS_ID` and `GOOGLE_SHEETS_API_KEY` exist.
- In `/api/shipping/plan/route.ts`, return a clear warning/debug field when the SKU DB fails to load because of configuration.
- Avoid silently making configuration failure look like normal missing SKU data.
- Do not break current plan generation.

## 6. Reduce Security Exposure

Files:

- `src/proxy.ts`
- `src/lib/auth-server.ts`

Problems:

- `SSCC_API_TOKEN` currently grants admin-equivalent access to all `/api/*`.
- `/api/debug/*` is public.

Fix:

- Keep external/automation auth, but narrow bearer-token access to explicitly allowed endpoints.
- At minimum, allow `/api/external/*` and any known automation endpoints that are actually needed.
- Do not let the bearer token access all admin/user/settings routes.
- Close `/api/debug/*` behind admin session or explicit token auth.
- Add a short code comment explaining which endpoints automation token can access and why.
- Preserve compatibility for known external API routes where possible.

## 7. Cleanup If Safe

Lint warnings found:

- unused `statCards` in `src/app/adjustments/page.tsx`
- unused imports and `statusIcons` in `src/app/shipping/page.tsx`

Remove these if it is safe and quick.

## Expected Result

- `npm run lint` has no errors.
- `npm run build` passes.
- Sidebar reflects which modules really work.
- Integrations page reports Walmart and Google Sheets more accurately.
- Feedback sync no longer pretends to be active if backend remains stubbed.
- Token/debug endpoint exposure is reduced.
