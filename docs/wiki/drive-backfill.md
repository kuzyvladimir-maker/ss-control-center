# ♻️ Drive Backfill — Layer 2 reliability

## Зачем
Слой 2 двухслойной схемы надёжности Google Drive upload. Слой 1 — синхронная загрузка в `/api/shipping/buy`. Если по любой причине не сработала (refresh token истёк, Drive API временно недоступен, Vercel function timeout) — Слой 2 догружает асинхронно так что PDF в любом случае оказывается в `Shipping Labels/` папке.

## Как работает

```
Layer 1 — synchronous (existing in /api/shipping/buy):
  Buy → попытка залить на Drive → успех = PDF на месте сразу.

Layer 2 — async safety net:
  n8n cron */15 * * * * → GET /api/cron/drive-backfill →
    сканирует ShippingPlanItem (status='bought', updatedAt < 30d,
    labelPdfUrl содержит "/api/shipping/label-pdf" или null) →
    извлекает shipmentId из proxy URL → скачивает PDF из Veeqo →
    заливает на Drive → обновляет labelPdfUrl на webViewLink.

Layer 3 — manual on-demand:
  /admin/integrations → "Run now" в DriveBackfillCard →
  POST /api/integrations/drive-backfill?lookbackDays=N →
  тот же flow что cron, но без 20-row limit (до 200/run).
```

## Endpoints

| Endpoint | Метод | Auth | Cap | Lookback |
|---|---|---|---|---|
| `/api/cron/drive-backfill` | GET | `Bearer ${CRON_SECRET}` | 20 строк/тик | 30 дней |
| `/api/integrations/drive-backfill` | POST | admin session / `SSCC_API_TOKEN` | 200 строк/run | 1-365 дней (body.lookbackDays) |
| `/api/integrations/drive-status` | GET | admin session / `SSCC_API_TOKEN` | n/a | n/a (диагностический endpoint) |

Оба back-fill endpoint'а возвращают одну форму: `{ found, lookbackDays, uploaded[], errors[], skipped[] }`.

## Cron — на n8n, не Vercel

Vercel Hobby план допускает только daily crons. `*/15 * * * *` в `vercel.json` ломает деплой (это нас уже кусало 2026-05-03 и 2026-05-15). Поэтому cron живёт в n8n на VPS: `docs/n8n-workflows/drive-backfill.json`.

Альтернативы если когда-то перейдёт на Vercel Pro:
1. Добавить в `vercel.json`:
   ```json
   { "path": "/api/cron/drive-backfill", "schedule": "*/15 * * * *" }
   ```
2. Отключить n8n workflow

## Конфигурация
- `CRON_SECRET` — Bearer token для n8n auth (общий с другими cron)
- `SSCC_API_TOKEN` — альтернативный токен для n8n (если CRON_SECRET не задан, middleware его принимает)
- Все `GOOGLE_OAUTH_*` env vars (см. [google-drive-setup.md](google-drive-setup.md))
- `VEEQO_API_KEY` — back-fill повторно скачивает PDF из Veeqo

## Когда срабатывает back-fill
- Synchronous upload в `/api/shipping/buy` упал (refresh token истёк за час до этого)
- Drive API временно недоступен в момент покупки
- Vercel function timeout не успел дойти до Drive upload

После настройки достаточно проверять Vercel logs раз в неделю на `[drive-backfill]` строки. Если errors не растут, всё ОК.

## История
- 2026-05-15: Layer 2 запущен в составе fix Drive upload production outage (см. `docs/dev-log/2026-05-15-drive-upload-fix.md`)

## Связи
- ← [Google Drive setup](google-drive-setup.md)
- ← [Shipping Labels Page v1](shipping-labels-page-v1.md)
- ⇔ [n8n Автоматизация](n8n-automation.md) (workflow JSON)
- ⊂ [MASTER_PROMPT v3.3](../MASTER_PROMPT_v3.3.md) §8
