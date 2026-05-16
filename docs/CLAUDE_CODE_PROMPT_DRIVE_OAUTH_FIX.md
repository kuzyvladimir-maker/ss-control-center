# CLAUDE CODE PROMPT — Drive OAuth Cleanup + Shipping Labels Audit Fixes

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-15
> **Context:** Vladimir reported that purchased labels are not being saved to Google Drive in production. Audit revealed: (1) code uses OAuth, but `.env.example` + docs describe service account (mismatch); (2) UI shows misleading "PDF saved" green count even when fallback to proxy URL fires.
> **Execution mode:** один цельный коммит

---

## 🎯 ЦЕЛЬ

Привести `.env.example`, UI counters и audit-trail в соответствие с реальной реализацией Drive integration на OAuth (см. `src/lib/google-drive.ts`). Также — улучшить видимость Drive failures чтобы тихие сбои больше не выглядели как успех.

**Не трогать:** саму логику `src/lib/google-drive.ts` (работает корректно), `src/app/api/shipping/buy/route.ts` flow (тоже корректен).

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

1. **`docs/wiki/google-drive-setup.md`** — обновлённая wiki (на OAuth setup). Это source of truth для env vars.
2. **`src/lib/google-drive.ts`** — реализация. Подтверждённые имена env vars: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER`.

---

## 🏗️ ШАГ 1 — Обновить `.env.example`

### Найти в `ss-control-center/.env.example` блок:

```
# Google Drive — used for shipping label PDF storage
GOOGLE_DRIVE_ROOT_FOLDER=
# Service account JSON key (raw JSON one-liner OR base64-encoded).
# See docs/wiki/google-drive-setup.md for the full setup steps:
# create service account → share folder with its email → paste here.
# When unset, labels still buy successfully and the modal links to the
# Veeqo-hosted label URL as fallback (PDFs aren't pushed to Drive).
GOOGLE_SERVICE_ACCOUNT_JSON=
```

### Заменить на:

```
# Google Drive — used for shipping label PDF storage.
#
# Auth: OAuth2 refresh token on behalf of the folder owner
# (kuzy.vladimir@gmail.com). Service account does NOT work on personal
# Gmail Drive — service accounts have no storage quota and personal
# Gmail isn't a Workspace Shared Drive.
#
# See docs/wiki/google-drive-setup.md for the full one-time setup:
# Google Cloud Console → OAuth client → OAuth Playground for refresh token.
#
# When unset, labels still buy successfully — the modal links to the
# Veeqo-hosted label URL via /api/shipping/label-pdf as fallback (PDFs
# aren't pushed to Drive in that case).
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
GOOGLE_DRIVE_ROOT_FOLDER=
# Legacy alias for GOOGLE_DRIVE_ROOT_FOLDER. Kept for backward compat
# (existing deployments may have this name set); new deployments use
# GOOGLE_DRIVE_ROOT_FOLDER.
# GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID=
```

---

## 🏗️ ШАГ 2 — UI: Исправить misleading "PDF saved" counter

### Файл: `src/app/shipping/page.tsx`

Найти компонент `BuyReportDialog`. В нём есть три KPI карточки в `<div className="grid grid-cols-3 gap-2">`:

```jsx
<div className="rounded border border-rule bg-surface-tint p-2">
  <div className="text-[11px] text-ink-3">PDF saved</div>
  <div
    className={cn(
      "text-base font-semibold",
      pdfMissing === 0 ? "text-green-ink" : "text-warn-strong"
    )}
  >
    {okCount - pdfMissing}/{okCount}
  </div>
</div>
```

`pdfMissing` вычисляется как `report.bought.filter((b) => !b.pdfSaved).length`. А `pdfSaved` устанавливается `labelPath != null` — что **истина даже для proxy fallback** (proxy URL всегда даёт labelPath). В результате счётчик показывает зелёное "5/5 saved" даже когда Drive упал и все PDF только в Veeqo.

### Заменить логику счётчика на основе `pdfSource`:

```typescript
// Вверху BuyReportDialog где вычисляются okCount/failCount/pdfMissing
const okCount = report.bought.length;
const failCount = report.errors.length;
// Реально на Drive ушли только те, где pdfSource === "drive".
// proxy/disk/none — это fallback (PDF доступен, но не в архиве на Drive).
const driveCount = report.bought.filter((b) => b.pdfSource === "drive").length;
const proxyOrDiskCount = report.bought.filter(
  (b) => b.pdfSource === "proxy" || b.pdfSource === "disk"
).length;
const noneCount = report.bought.filter((b) => b.pdfSource === "none").length;
const allOnDrive = okCount > 0 && driveCount === okCount;
const allOk = failCount === 0 && allOnDrive;
```

И заменить KPI карточку "PDF saved" на:

```jsx
<div className="rounded border border-rule bg-surface-tint p-2">
  <div className="text-[11px] text-ink-3">On Drive</div>
  <div
    className={cn(
      "text-base font-semibold",
      driveCount === okCount
        ? "text-green-ink"
        : driveCount > 0
          ? "text-warn-strong"
          : "text-danger"
    )}
  >
    {driveCount}/{okCount}
  </div>
</div>
```

### Добавить prominent warning баннер если есть Drive failures

После KPI grid и перед списком "Purchased" — добавить:

```jsx
{proxyOrDiskCount > 0 && (
  <div className="rounded border border-warn-strong bg-warn-tint p-2 text-[12px]">
    <div className="flex items-start gap-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn-strong" />
      <div>
        <div className="font-medium text-warn-strong">
          {proxyOrDiskCount} of {okCount} labels NOT saved to Drive
        </div>
        <div className="text-[11px] text-ink-2 mt-0.5">
          These PDFs are accessible via fallback URLs but aren't archived
          in <code>Shipping Labels</code> folder. Most common cause:
          <code>GOOGLE_OAUTH_*</code> env vars missing on Vercel. See
          <a
            href="/admin/integrations"
            className="text-info underline ml-1"
          >
            Integrations
          </a>{" "}
          or wiki/google-drive-setup.md.
        </div>
        {/* Show the first unique error to help diagnose without
            spelunking individual rows. */}
        {(() => {
          const firstErr = report.bought.find((b) => b.driveError)?.driveError;
          if (!firstErr) return null;
          return (
            <div className="text-[11px] text-ink-3 mt-1 font-mono">
              {firstErr}
            </div>
          );
        })()}
      </div>
    </div>
  </div>
)}
```

### Поднять видимость `pdfSource` в индивидуальной карточке

Текущий код:
```jsx
<div className="text-[10px] text-ink-3">
  PDF source: <span>...</span>
  {b.driveError && <span>· Drive: {b.driveError}</span>}
</div>
```

Заменить на (более крупный, цветовая логика):
```jsx
<div className="text-[11px] mt-0.5">
  PDF:{" "}
  <span
    className={cn(
      "font-medium",
      b.pdfSource === "drive"
        ? "text-green-ink"
        : b.pdfSource === "proxy"
          ? "text-warn-strong"
          : b.pdfSource === "disk"
            ? "text-info"
            : "text-danger"
    )}
  >
    {b.pdfSource === "drive"
      ? "✓ on Drive"
      : b.pdfSource === "proxy"
        ? "via Veeqo proxy (not on Drive)"
        : b.pdfSource === "disk"
          ? "local disk only"
          : "missing"}
  </span>
</div>
```

---

## 🏗️ ШАГ 3 — Diagnostic endpoint для проверки Drive статуса

Добавить публичный (только admin) endpoint который показывает статус Drive integration без необходимости лезть в Vercel logs.

### Файл: `src/app/api/integrations/drive-status/route.ts` (новый)

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";
import { getDriveStatus } from "@/lib/google-drive";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const status = getDriveStatus();
  // Also include WHICH env vars are present (without leaking values) —
  // helps Vladimir verify what's actually deployed to Vercel vs what
  // .env.example documents.
  const envSnapshot = {
    GOOGLE_OAUTH_CLIENT_ID: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: Boolean(process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    GOOGLE_OAUTH_REFRESH_TOKEN: Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN),
    GOOGLE_DRIVE_ROOT_FOLDER: Boolean(process.env.GOOGLE_DRIVE_ROOT_FOLDER),
    GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID: Boolean(
      process.env.GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID
    ),
    // Surface stale env that might confuse the operator
    GOOGLE_SERVICE_ACCOUNT_JSON_PRESENT: Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ),
  };

  return NextResponse.json({
    ...status,
    env: envSnapshot,
    // If service account env is set but OAuth is missing — Vladimir
    // probably followed the old wiki. Surface this explicitly.
    legacyServiceAccountWarning:
      envSnapshot.GOOGLE_SERVICE_ACCOUNT_JSON_PRESENT &&
      !envSnapshot.GOOGLE_OAUTH_REFRESH_TOKEN
        ? "Legacy GOOGLE_SERVICE_ACCOUNT_JSON env is set but code uses OAuth. Follow wiki/google-drive-setup.md and switch to GOOGLE_OAUTH_* variables, then remove GOOGLE_SERVICE_ACCOUNT_JSON."
        : null,
  });
}
```

### (Опционально) Surface на странице `/admin/integrations`

Если такая страница уже существует — добавить туда блок "Google Drive" с GET на новый endpoint, показать `configured`, `reason`, env snapshot, и warning если legacy env set.

Если страницы нет — пропустить этот sub-step. Endpoint всё равно полезен для curl-теста.

---

## 🏗️ ШАГ 4 — Audit log: запомнить причину Drive failure

В `src/app/api/shipping/buy/route.ts` функция `appendBuyLog()` уже пишет в `logs/shipping-buy.jsonl`. Расширить её чтобы записывала `pdfSource` и `driveError` тоже:

В блоке где формируется `bought` array для лога:
```typescript
bought: results.bought.map((b) => ({
  orderNumber: b.orderNumber,
  tracking: b.tracking,
  pdfSaved: b.pdfSaved,
  labelPath: b.labelPath,
  carrier: b.carrier,
  service: b.service,
  price: b.price,
  // ↑↑ existing
  pdfSource: b.pdfSource,
  driveError: b.driveError,
  // ↑↑ ADD
})),
```

Это нужно чтобы при последующем расследовании можно было увидеть исторические Drive failures.

---

## 🏗️ ШАГ 5 — README / CLAUDE.md mention

В `ss-control-center/CLAUDE.md` или `README.md` (если есть раздел про env setup) — добавить ссылку на обновлённую `wiki/google-drive-setup.md`. Не дублировать инструкции, просто:

```markdown
### Google Drive (shipping label PDFs)
See [docs/wiki/google-drive-setup.md](../docs/wiki/google-drive-setup.md).
Uses OAuth2 refresh token. **Service account does not work** on personal
Gmail Drive — don't try.
```

---

## ✅ ACCEPTANCE CRITERIA

1. `.env.example` описывает `GOOGLE_OAUTH_*` переменные, **не** `GOOGLE_SERVICE_ACCOUNT_JSON`.
2. После покупки этикеток с не-настроенным Drive — модалка показывает warning баннер с конкретной ошибкой, не зелёное "5/5 saved".
3. Когда Drive настроен правильно — счётчик "On Drive: 5/5" зелёный, на индивидуальных карточках "✓ on Drive".
4. `GET /api/integrations/drive-status` (с admin auth) возвращает JSON с `configured`, `reason`, и env snapshot.
5. Audit log `logs/shipping-buy.jsonl` содержит `pdfSource` и `driveError` для каждого заказа.

---

## 🚫 Что НЕ менять

- `src/lib/google-drive.ts` — реализация корректна, не трогать.
- Логику fallback в `src/app/api/shipping/buy/route.ts` (Drive → disk → proxy) — корректна.
- `MASTER_PROMPT_v3.3.md` — алгоритм не меняется.

---

## 📦 Финальный коммит

```
fix(shipping): align .env.example + UI counters with OAuth Drive integration

- Update .env.example: GOOGLE_OAUTH_* vars instead of GOOGLE_SERVICE_ACCOUNT_JSON
- Buy report dialog: counter "On Drive: X/Y" based on pdfSource, not labelPath
- Buy report dialog: prominent warning banner when proxy/disk fallback fires
- Surface pdfSource per-row with bigger text and clearer wording
- Add /api/integrations/drive-status endpoint for env diagnostics
- Audit log: include pdfSource and driveError in shipping-buy.jsonl

Root cause: Drive integration was migrated from service account to OAuth in
sprint 2026-05-14 (service account doesn't work on personal Gmail), but
.env.example and the setup wiki kept describing service account, so operator
configured GOOGLE_SERVICE_ACCOUNT_JSON in Vercel — which the code ignored.
Fallback to /api/shipping/label-pdf?shipmentId=X (Veeqo proxy) made the
failure look like success in the UI.

Wiki updated: docs/wiki/google-drive-setup.md rewritten to OAuth flow.
```

---

**End of prompt** — 2026-05-15
