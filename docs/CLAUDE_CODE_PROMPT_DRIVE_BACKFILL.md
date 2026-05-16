# CLAUDE CODE PROMPT — Drive Back-fill Cron + Admin Retry Button

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-15
> **Context:** Build the "safety net" layer of the dual-layer Drive upload reliability scheme. Layer 1 (synchronous upload in `/api/shipping/buy`) already exists. This prompt adds Layer 2 — Vercel cron that periodically scans for purchased labels whose PDFs didn't make it to Drive, and back-fills them. Plus an admin UI button to trigger the same job on-demand.
> **Execution mode:** один цельный коммит

---

## 🎯 ЦЕЛЬ

После выполнения этого промпта Drive upload будет работать так:

```
Слой 1 — синхронный (уже есть в /api/shipping/buy):
  Buy → попытка залить на Drive → успех = PDF на месте сразу.

Слой 2 — асинхронный safety net (этот промпт):
  Vercel cron каждые 15 мин → сканирует БД → находит заказы с
  labelPdfUrl не содержащим "drive.google.com" → скачивает PDF из
  Veeqo → заливает на Drive → обновляет labelPdfUrl на webViewLink.

Слой 3 — manual on-demand (этот промпт):
  Admin UI кнопка "Retry Drive backfill" в /admin/integrations →
  POST /api/integrations/drive-backfill?force=true → запускает тот же
  процесс что cron, но синхронно с прогресс-баром.
```

Цель — чтобы PDF гарантированно попал на Drive даже если синхронный путь упал по любой причине (token expired, Vercel function timeout, network glitch, etc).

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

1. **`docs/wiki/google-drive-setup.md`** — обновлённая wiki на OAuth setup.
2. **`src/lib/google-drive.ts`** — `uploadLabelPdf({folderSegments, filename, pdf})` + `getDriveStatus()`. Не трогаем, используем как есть.
3. **`src/app/api/shipping/buy/route.ts`** — для понимания формата labelPdfUrl (после Drive success содержит `drive.google.com`; иначе содержит `/api/shipping/label-pdf?shipmentId=X`).
4. **`src/app/api/shipping/label-drive-retry/route.ts`** — уже существующий retry endpoint для одного заказа. Берём за основу логику back-fill, обобщаем на batch.
5. **`src/app/api/cron/walmart/route.ts`** — паттерн cron auth через `CRON_SECRET` Bearer token. Копируем.
6. **`vercel.json`** — добавляем нашу новую cron запись.

---

## 🏗️ ШАГ 1 — Cron endpoint `/api/cron/drive-backfill`

### Файл: `src/app/api/cron/drive-backfill/route.ts` (новый)

```typescript
/**
 * GET /api/cron/drive-backfill
 *
 * Layer 2 of the Drive upload reliability scheme. Runs every 15 minutes.
 *
 * Scans for purchased labels whose PDFs didn't make it to Drive
 * (labelPdfUrl missing or pointing to our proxy fallback instead of
 * drive.google.com), downloads the PDF from Veeqo, uploads to Drive,
 * and updates the DB row with the Drive webViewLink.
 *
 * Bounds:
 *   - Only processes ShippingPlanItem rows with status='bought' and
 *     updatedAt within the last 30 days. Older rows are considered
 *     archival — backfill on demand only.
 *   - Max 20 rows per invocation to stay within Vercel function
 *     timeout (60s on Pro plan). The next cron tick picks up the
 *     leftover; queue drains within ~3 ticks for typical loads.
 *
 * Auth: same Bearer ${CRON_SECRET} as other cron routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { uploadLabelPdf, getDriveStatus } from "@/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "@/lib/shipping-label-files";

const MAX_BATCH_SIZE = 20;
const LOOKBACK_DAYS = 30;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev/local: no gate
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function fetchVeeqoLabelPdf(shipmentId: string): Promise<Buffer> {
  const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  const apiKey = process.env.VEEQO_API_KEY;
  if (!apiKey) throw new Error("VEEQO_API_KEY not configured");

  const url = `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/pdf",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veeqo ${res.status}: ${text.slice(0, 200)}`);
  }

  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length < 1000 || pdf.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(
      `Veeqo returned non-PDF: ${pdf.length} bytes, ` +
        `${pdf.slice(0, 80).toString("utf-8")}`
    );
  }
  return pdf;
}

// Extracts shipment id from a labelPdfUrl pointing to our proxy.
// Returns null for anything that doesn't match the expected proxy shape.
function extractShipmentId(labelPdfUrl: string | null): string | null {
  if (!labelPdfUrl) return null;
  // Match both absolute and relative URLs:
  //   /api/shipping/label-pdf?shipmentId=1196697352
  //   https://salutemsolutions.info/api/shipping/label-pdf?shipmentId=...
  const m = labelPdfUrl.match(/shipmentId=(\d+)/);
  return m ? m[1] : null;
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // Don't waste API calls if Drive is misconfigured — surface that
  // explicitly to logs so on-call can fix and the queue drains next
  // tick.
  const status = getDriveStatus();
  if (!status.configured) {
    console.error(
      `[drive-backfill] Drive not configured: ${status.reason}. ` +
        `Skipping run. Configure GOOGLE_OAUTH_* env vars to enable.`
    );
    return NextResponse.json(
      {
        skipped: true,
        reason: status.reason,
      },
      { status: 200 }
    );
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  // Candidates: bought items whose labelPdfUrl is either missing or
  // points to our proxy (i.e. NOT on Drive). The `contains` filter
  // covers both shapes since Drive webViewLinks always include
  // "drive.google.com".
  const candidates = await prisma.shippingPlanItem.findMany({
    where: {
      status: "bought",
      updatedAt: { gte: cutoff },
      OR: [
        { labelPdfUrl: null },
        { labelPdfUrl: { contains: "/api/shipping/label-pdf" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_BATCH_SIZE,
  });

  const results = {
    found: candidates.length,
    uploaded: [] as Array<{
      itemId: string;
      orderNumber: string;
      shipmentId: string;
      labelPath: string;
    }>,
    errors: [] as Array<{
      itemId: string;
      orderNumber: string;
      reason: string;
    }>,
    skipped: [] as Array<{
      itemId: string;
      orderNumber: string;
      reason: string;
    }>,
  };

  for (const item of candidates) {
    const shipmentId = extractShipmentId(item.labelPdfUrl);
    if (!shipmentId) {
      results.skipped.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        reason: "Cannot extract shipmentId from labelPdfUrl",
      });
      continue;
    }

    try {
      const pdf = await fetchVeeqoLabelPdf(shipmentId);
      const filename = buildPdfFilename(item);
      const folderPath = buildFolderPath(item);
      const drive = await uploadLabelPdf({
        folderSegments: folderPath.split("/"),
        filename,
        pdf,
      });

      if (!drive.ok) {
        results.errors.push({
          itemId: item.id,
          orderNumber: item.orderNumber,
          reason: drive.reason,
        });
        continue;
      }

      await prisma.shippingPlanItem.update({
        where: { id: item.id },
        data: { labelPdfUrl: drive.result.webViewLink },
      });

      results.uploaded.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        shipmentId,
        labelPath: drive.result.webViewLink,
      });
    } catch (e) {
      results.errors.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Surface a one-line summary in Vercel logs so monitoring can grep.
  console.log(
    `[drive-backfill] found=${results.found} ` +
      `uploaded=${results.uploaded.length} ` +
      `errors=${results.errors.length} ` +
      `skipped=${results.skipped.length}`
  );

  return NextResponse.json(results);
}
```

---

## 🏗️ ШАГ 2 — Зарегистрировать cron в `vercel.json`

В `ss-control-center/vercel.json` в массиве `crons` добавить:

```json
{
  "path": "/api/cron/drive-backfill",
  "schedule": "*/15 * * * *"
}
```

> Schedule `*/15 * * * *` = каждые 15 минут. Vercel Hobby план поддерживает minimum 1 minute, Pro — больше частот. 15 минут — разумный компромисс: запоздание загрузки PDF на Drive не критично, но и долго ждать тоже плохо.

---

## 🏗️ ШАГ 3 — Manual on-demand endpoint `/api/integrations/drive-backfill`

Тот же flow что cron, но с admin auth (не CRON_SECRET) и без 20-row limit (admin запустил вручную — пусть прокручивает всё).

### Файл: `src/app/api/integrations/drive-backfill/route.ts` (новый)

```typescript
/**
 * POST /api/integrations/drive-backfill
 *
 * On-demand admin trigger for the Drive backfill job. Same logic as
 * /api/cron/drive-backfill but without the row limit and with admin
 * auth instead of CRON_SECRET.
 *
 * Body (optional):
 *   { lookbackDays?: number }  — default 30, max 365
 *
 * Response: same shape as cron endpoint (found/uploaded/errors/skipped).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import { uploadLabelPdf, getDriveStatus } from "@/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "@/lib/shipping-label-files";

// On-demand variant: no per-invocation row cap, but still bounded by
// Vercel function timeout (60s Pro). For very large back-fills the
// admin may need to invoke twice.
const MAX_BATCH_SIZE = 200;

async function fetchVeeqoLabelPdf(shipmentId: string): Promise<Buffer> {
  // Same as cron version — extracted to a shared helper would be
  // cleaner but this file stays self-contained for diagnostic clarity.
  const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  const apiKey = process.env.VEEQO_API_KEY;
  if (!apiKey) throw new Error("VEEQO_API_KEY not configured");

  const url = `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, Accept: "application/pdf" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veeqo ${res.status}: ${text.slice(0, 200)}`);
  }
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length < 1000 || pdf.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`Veeqo returned non-PDF: ${pdf.length} bytes`);
  }
  return pdf;
}

function extractShipmentId(labelPdfUrl: string | null): string | null {
  if (!labelPdfUrl) return null;
  const m = labelPdfUrl.match(/shipmentId=(\d+)/);
  return m ? m[1] : null;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const lookbackDays = Math.min(
    Math.max(Number(body.lookbackDays ?? 30), 1),
    365
  );

  const status = getDriveStatus();
  if (!status.configured) {
    return NextResponse.json(
      {
        error: `Drive not configured: ${status.reason}`,
        configured: false,
      },
      { status: 503 }
    );
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const candidates = await prisma.shippingPlanItem.findMany({
    where: {
      status: "bought",
      updatedAt: { gte: cutoff },
      OR: [
        { labelPdfUrl: null },
        { labelPdfUrl: { contains: "/api/shipping/label-pdf" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_BATCH_SIZE,
  });

  const results = {
    found: candidates.length,
    lookbackDays,
    uploaded: [] as Array<{
      itemId: string;
      orderNumber: string;
      shipmentId: string;
      labelPath: string;
    }>,
    errors: [] as Array<{
      itemId: string;
      orderNumber: string;
      reason: string;
    }>,
    skipped: [] as Array<{
      itemId: string;
      orderNumber: string;
      reason: string;
    }>,
  };

  for (const item of candidates) {
    const shipmentId = extractShipmentId(item.labelPdfUrl);
    if (!shipmentId) {
      results.skipped.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        reason: "Cannot extract shipmentId from labelPdfUrl",
      });
      continue;
    }

    try {
      const pdf = await fetchVeeqoLabelPdf(shipmentId);
      const filename = buildPdfFilename(item);
      const folderPath = buildFolderPath(item);
      const drive = await uploadLabelPdf({
        folderSegments: folderPath.split("/"),
        filename,
        pdf,
      });
      if (!drive.ok) {
        results.errors.push({
          itemId: item.id,
          orderNumber: item.orderNumber,
          reason: drive.reason,
        });
        continue;
      }
      await prisma.shippingPlanItem.update({
        where: { id: item.id },
        data: { labelPdfUrl: drive.result.webViewLink },
      });
      results.uploaded.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        shipmentId,
        labelPath: drive.result.webViewLink,
      });
    } catch (e) {
      results.errors.push({
        itemId: item.id,
        orderNumber: item.orderNumber,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json(results);
}
```

---

## 🏗️ ШАГ 4 — Admin UI: кнопка `Retry Drive backfill`

Если в проекте есть страница `/admin/integrations` (или подобная) — добавь блок для Drive:

```tsx
// src/app/admin/integrations/DriveBackfillCard.tsx (новый)

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CloudUpload, RefreshCw, AlertTriangle } from "lucide-react";

interface BackfillResult {
  found: number;
  lookbackDays: number;
  uploaded: { orderNumber: string; labelPath: string }[];
  errors: { orderNumber: string; reason: string }[];
  skipped: { orderNumber: string; reason: string }[];
}

export function DriveBackfillCard() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookback, setLookback] = useState(30);

  async function runBackfill() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/integrations/drive-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookbackDays: lookback }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded border border-rule bg-surface p-3 space-y-3">
      <div className="flex items-center gap-2">
        <CloudUpload size={16} className="text-info" />
        <div className="font-medium text-ink">Google Drive — back-fill</div>
      </div>
      <div className="text-[12px] text-ink-2">
        Find purchased labels whose PDFs aren&apos;t on Drive yet and upload
        them. Runs automatically every 15 minutes via Vercel cron; click
        below to trigger immediately.
      </div>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-ink-2">Look back:</span>
        <select
          value={lookback}
          onChange={(e) => setLookback(Number(e.target.value))}
          disabled={running}
          className="rounded border border-rule bg-surface px-2 py-1"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
        </select>
        <Button onClick={runBackfill} disabled={running} size="sm">
          {running ? (
            <>
              <RefreshCw size={13} className="mr-1 animate-spin" /> Running…
            </>
          ) : (
            "Run now"
          )}
        </Button>
      </div>

      {error && (
        <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <div className="rounded border border-rule bg-surface-tint p-2 text-[11.5px] space-y-1">
          <div>
            Found <span className="font-mono">{result.found}</span> candidates
            in last {result.lookbackDays} days.
          </div>
          {result.uploaded.length > 0 && (
            <div className="text-green-ink">
              ✓ Uploaded {result.uploaded.length}:{" "}
              {result.uploaded
                .slice(0, 5)
                .map((u) => u.orderNumber)
                .join(", ")}
              {result.uploaded.length > 5 &&
                ` and ${result.uploaded.length - 5} more`}
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="text-danger">
              ✗ Errors {result.errors.length}:{" "}
              {result.errors
                .slice(0, 3)
                .map((e) => `${e.orderNumber} (${e.reason.slice(0, 40)})`)
                .join("; ")}
              {result.errors.length > 3 && `… +${result.errors.length - 3}`}
            </div>
          )}
          {result.skipped.length > 0 && (
            <div className="text-ink-3">
              ↷ Skipped {result.skipped.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Импорт и встроить компонент на странице `/admin/integrations` (или где у тебя живут админ-инструменты).

---

## 🏗️ ШАГ 5 — Wiki update

Создать (или обновить) `docs/wiki/drive-backfill.md`:

```markdown
# ♻️ Drive Backfill — Layer 2 reliability

## Зачем
Слой 2 двухслойной схемы надёжности Google Drive upload. Слой 1 — синхронная загрузка в `/api/shipping/buy`. Если она по любой причине не сработала (token expired, network glitch, Vercel timeout), Слой 2 догрузит асинхронно.

## Как работает
- `/api/cron/drive-backfill` — Vercel cron, каждые 15 минут. Бьёт limit 20 заказов/тик.
- `/api/integrations/drive-backfill` — manual trigger из admin UI, до 200 заказов/тик.

Оба сканируют `ShippingPlanItem` со `status = 'bought'` и `labelPdfUrl` не содержащим `drive.google.com`. Для каждого — извлекают shipmentId из proxy URL, скачивают PDF из Veeqo, заливают на Drive по правильному пути, обновляют `labelPdfUrl`.

## Конфигурация
- `CRON_SECRET` — Bearer token для Vercel cron auth (общий с другими cron)
- Все `GOOGLE_OAUTH_*` env vars (см. [google-drive-setup.md](google-drive-setup.md))

## Когда срабатывает back-fill
- Synchronous upload в buy упал (например refresh token истёк за час до этого)
- Drive API временно недоступен в момент покупки
- Vercel function timeout не успел дойти до Drive upload

После настройки cron достаточно проверять Vercel logs раз в неделю на `[drive-backfill]` строки — если errors не растут, всё ОК.

## Связи
- ← [Google Drive setup](google-drive-setup.md)
- ← [Shipping Labels Page v1](shipping-labels-page-v1.md)
- ⊂ [MASTER_PROMPT v3.3](../MASTER_PROMPT_v3.3.md) §8
```

И добавить ссылку в `docs/wiki/index.md` в раздел "Модули" или "Интеграции".

---

## ✅ ACCEPTANCE CRITERIA

1. `GET /api/cron/drive-backfill` с правильным Bearer token возвращает JSON с `found/uploaded/errors/skipped`.
2. `vercel.json` содержит новую cron entry, после deploy Vercel показывает её в Cron Jobs UI.
3. `POST /api/integrations/drive-backfill` с admin auth работает аналогично, но без 20-row limit.
4. На admin странице кнопка `Run now` запускает back-fill и показывает результат.
5. Когда Drive **настроен**: после неудачной синхронной загрузки → cron через 15 минут догружает → `labelPdfUrl` обновляется на `https://drive.google.com/...`.
6. Когда Drive **не настроен**: cron логирует skip с reason, не падает.

---

## 🚫 Что НЕ менять

- `src/lib/google-drive.ts` — корректная реализация.
- `src/app/api/shipping/buy/route.ts` — Layer 1 уже корректен.
- `src/app/api/shipping/label-drive-retry/route.ts` — оставить для одиночного retry по конкретному shipmentId (он принимает один shipmentId, а наш back-fill сам сканит БД).

---

## 📦 Финальный коммит

```
feat(shipping): Drive upload Layer 2 — cron back-fill + admin retry

Builds the safety net half of the dual-layer Drive reliability scheme.

- Add /api/cron/drive-backfill: every 15min, finds labels not on Drive,
  uploads from Veeqo. Bounded to 20/tick to fit Vercel function timeout.
- Add /api/integrations/drive-backfill: same logic, admin-triggered, up
  to 200/run. Used by the new admin UI button.
- Add DriveBackfillCard in admin/integrations: configurable lookback
  window, live status, error breakdown.
- vercel.json: register new cron at */15 minute schedule.
- docs/wiki/drive-backfill.md: explain layer model + ops handbook.

After this, a single Drive upload failure can no longer lose a PDF —
worst case the file appears on Drive within 15 minutes of purchase
instead of immediately.
```

---

**End of prompt** — 2026-05-15
