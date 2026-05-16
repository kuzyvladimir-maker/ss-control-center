# CLAUDE CODE PROMPT — Drive Upload Final Deploy (master)

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-15
> **Цель:** Закрыть всю историю с Google Drive upload одной сессией. Прогнать через всё что было готово, плюс залить credentials в Vercel и сделать redeploy.
> **Execution mode:** последовательно, один цельный коммит в конце

---

## КОНТЕКСТ

Vladimir вручную получил OAuth credentials для Google Drive API через Google Cloud Console + OAuth Playground (15 мая 2026). Три значения уже записаны локально в `ss-control-center/.env.local` (этот файл в `.gitignore`, не коммитится). Тебе нужно использовать их, чтобы:

1. Установить env vars в Vercel production
2. Удалить устаревшую `GOOGLE_SERVICE_ACCOUNT_JSON` из Vercel если она там есть
3. Прогнать два cleanup-промпта (UI fix + cron back-fill)
4. Триггерить redeploy через git push
5. Проверить что Drive upload работает

После выполнения этого промпта Drive integration должна работать end-to-end. Vladimir купит этикетку → PDF появится на Google Drive в правильной папке.

**Reuse OAuth client от Джеки**, не выпускали новый: тот же `n8n-automation-469920` GCP project, тот же Web application client `20898102329-e3ct9d4d76l67o0chtoru0p29epfvqso`, но **второй secret** (Add secret) выпущен 15 мая чтобы получить значение которое Google больше не показывает на UI.

---

## ШАГ 1 — Установить env vars в Vercel production

### Pre-flight check

Проверь что `vercel` CLI установлен и Vladimir залогинен:

```bash
cd /Users/amazon/ss-control-center/ss-control-center
which vercel || npm install -g vercel
vercel whoami
```

Если `vercel whoami` выдаёт ошибку «Not authenticated» — попроси Vladimir выполнить `vercel login` в терминале (один раз откроется браузер для авторизации Google или GitHub, дальше CLI запомнит token локально).

### Прочитать credentials из .env.local

```bash
cd /Users/amazon/ss-control-center/ss-control-center
cat .env.local
```

Файл содержит четыре переменные:
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `GOOGLE_DRIVE_ROOT_FOLDER`

### Удалить старые env (clean slate)

```bash
# Removes existing values silently if they exist (true if absent).
vercel env rm GOOGLE_OAUTH_CLIENT_ID production -y 2>/dev/null || true
vercel env rm GOOGLE_OAUTH_CLIENT_SECRET production -y 2>/dev/null || true
vercel env rm GOOGLE_OAUTH_REFRESH_TOKEN production -y 2>/dev/null || true
vercel env rm GOOGLE_DRIVE_ROOT_FOLDER production -y 2>/dev/null || true

# Legacy variable — code больше её не читает. Удалить чтобы не сбивала /api/integrations/drive-status.
vercel env rm GOOGLE_SERVICE_ACCOUNT_JSON production -y 2>/dev/null || true
```

### Установить каждую переменную в production

```bash
# Load values from .env.local into the current shell
set -a
source .env.local
set +a

# Push each to Vercel. `echo -n` + pipe is the supported non-interactive form.
echo -n "$GOOGLE_OAUTH_CLIENT_ID" | vercel env add GOOGLE_OAUTH_CLIENT_ID production
echo -n "$GOOGLE_OAUTH_CLIENT_SECRET" | vercel env add GOOGLE_OAUTH_CLIENT_SECRET production
echo -n "$GOOGLE_OAUTH_REFRESH_TOKEN" | vercel env add GOOGLE_OAUTH_REFRESH_TOKEN production
echo -n "$GOOGLE_DRIVE_ROOT_FOLDER" | vercel env add GOOGLE_DRIVE_ROOT_FOLDER production
```

Если `echo | vercel env add` не подхватывает значение (Vercel CLI на некоторых версиях требует tty) — fallback с интерактивным вводом:

```bash
vercel env add GOOGLE_OAUTH_CLIENT_ID production
# CLI попросит ввести значение → скопировать из .env.local и вставить

# повторить для остальных трёх
```

Опционально продублировать в `preview` и `development`:

```bash
for ENV in preview development; do
  echo -n "$GOOGLE_OAUTH_CLIENT_ID" | vercel env add GOOGLE_OAUTH_CLIENT_ID $ENV
  echo -n "$GOOGLE_OAUTH_CLIENT_SECRET" | vercel env add GOOGLE_OAUTH_CLIENT_SECRET $ENV
  echo -n "$GOOGLE_OAUTH_REFRESH_TOKEN" | vercel env add GOOGLE_OAUTH_REFRESH_TOKEN $ENV
  echo -n "$GOOGLE_DRIVE_ROOT_FOLDER" | vercel env add GOOGLE_DRIVE_ROOT_FOLDER $ENV
done
```

### Verify

```bash
vercel env ls production | grep GOOGLE
```

Должны быть четыре строки `GOOGLE_OAUTH_*` и `GOOGLE_DRIVE_ROOT_FOLDER`. **`GOOGLE_SERVICE_ACCOUNT_JSON` — отсутствовать.** Если присутствует — `vercel env rm GOOGLE_SERVICE_ACCOUNT_JSON production -y`.

---

## ШАГ 2 — Прогнать промпт `CLAUDE_CODE_PROMPT_DRIVE_OAUTH_FIX.md`

Прочитай файл `/Users/amazon/ss-control-center/docs/CLAUDE_CODE_PROMPT_DRIVE_OAUTH_FIX.md` и выполни ВСЕ его шаги. Кратко:

1. Обновить `ss-control-center/.env.example` — заменить старый `GOOGLE_SERVICE_ACCOUNT_JSON` блок на `GOOGLE_OAUTH_*` блок (точный текст в промпте).
2. Поправить `src/app/shipping/page.tsx` (`BuyReportDialog`):
   - Заменить counter `PDF saved` → `On Drive` с подсчётом по `pdfSource === "drive"`
   - Добавить prominent warning баннер при `proxy`/`disk` fallback
   - Поднять читаемость pdfSource на индивидуальных карточках (с 10px на нормальный размер с цветовой логикой)
3. Создать `src/app/api/integrations/drive-status/route.ts` (diagnostic endpoint).
4. Расширить `appendBuyLog` в `src/app/api/shipping/buy/route.ts` — добавить `pdfSource` и `driveError` в записываемый JSON.
5. (Опционально) обновить `CLAUDE.md` / `README.md` со ссылкой на `wiki/google-drive-setup.md`.

Все детальные инструкции и точные сниппеты кода — внутри файла промпта.

---

## ШАГ 3 — Прогнать промпт `CLAUDE_CODE_PROMPT_DRIVE_BACKFILL.md`

Прочитай файл `/Users/amazon/ss-control-center/docs/CLAUDE_CODE_PROMPT_DRIVE_BACKFILL.md` и выполни ВСЕ его шаги:

1. Создать `src/app/api/cron/drive-backfill/route.ts` (Vercel cron каждые 15 мин)
2. Зарегистрировать новую cron entry в `vercel.json` (`*/15 * * * *`)
3. Создать `src/app/api/integrations/drive-backfill/route.ts` (admin on-demand)
4. Создать `src/app/admin/integrations/DriveBackfillCard.tsx` (React UI компонент)
5. Встроить `DriveBackfillCard` на страницу `/admin/integrations`. Если её нет — создать минимальную `src/app/admin/integrations/page.tsx` которая просто рендерит компонент в `<RequireAdmin>` обёртке.
6. Создать `docs/wiki/drive-backfill.md`
7. Обновить `docs/wiki/index.md` (добавить ссылку) и `docs/wiki/CONNECTIONS.md` (добавить связи)

Все детальные сниппеты — внутри файла промпта.

---

## ШАГ 4 — Commit и redeploy

Собрать все изменения из ШАГА 2 и 3 в один коммит:

```bash
cd /Users/amazon/ss-control-center/ss-control-center

# Sanity check — .env.local НЕ должен попасть в staged changes
git status
# Если .env.local появляется в staged — что-то с .gitignore не так, останови процесс
# и проверь что `git check-ignore .env.local` возвращает .env.local.

git add .
git commit -m "fix(shipping): Drive upload — OAuth env alignment + dual-layer reliability

Resolves the issue where purchased label PDFs weren't being saved to
Google Drive in production. Root cause: code was migrated from service
account to OAuth refresh token (service accounts don't work on personal
Gmail Drive — no storage quota without Workspace Shared Drive), but
.env.example and the setup wiki kept describing the service account
flow, so the operator configured the wrong env vars in Vercel.

Fixes:
- .env.example: GOOGLE_OAUTH_* vars replace GOOGLE_SERVICE_ACCOUNT_JSON
- Vercel env vars: GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN +
  GOOGLE_DRIVE_ROOT_FOLDER set in production; legacy
  GOOGLE_SERVICE_ACCOUNT_JSON removed.
- BuyReportDialog: counter 'On Drive: X/Y' based on pdfSource, not
  labelPath. Prominent warning banner when proxy/disk fallback fires.
- Per-row pdfSource readability: larger text, colour-coded.
- /api/integrations/drive-status: env snapshot diagnostic endpoint.
- Audit log shipping-buy.jsonl: include pdfSource and driveError.

Reliability — added Layer 2 safety net:
- /api/cron/drive-backfill: every 15min, finds purchased labels not on
  Drive yet, uploads from Veeqo. Bounded 20/tick.
- /api/integrations/drive-backfill: admin-triggered, up to 200/run.
- DriveBackfillCard on /admin/integrations: configurable lookback,
  live status, error breakdown.

Wiki: google-drive-setup.md rewritten on OAuth flow; new
drive-backfill.md explains layer model + ops handbook."

git push origin main
```

Push в `main` автоматически триггерит Vercel production deploy. Если у Vladimir отключён auto-deploy на push — явно тригернуть:

```bash
vercel --prod
```

Подожди ~2-3 минуты пока deploy завершится. Логи смотрятся через `vercel logs --follow` или в Dashboard.

---

## ШАГ 5 — Verify end-to-end

После завершения deploy:

### A. Drive status endpoint (бесшумная проверка)

```bash
# Получить admin session cookie (Vladimir-у залогиниться в браузере на проде, скопировать cookie)
# либо использовать SSCC_API_TOKEN если admin endpoints настроены под него
curl -s https://<your-vercel-domain>/api/integrations/drive-status \
  -H "Cookie: <admin-session-cookie>" | jq
```

Ожидаемый JSON:
```json
{
  "configured": true,
  "reason": null,
  "env": {
    "GOOGLE_OAUTH_CLIENT_ID": true,
    "GOOGLE_OAUTH_CLIENT_SECRET": true,
    "GOOGLE_OAUTH_REFRESH_TOKEN": true,
    "GOOGLE_DRIVE_ROOT_FOLDER": true,
    "GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID": false,
    "GOOGLE_SERVICE_ACCOUNT_JSON_PRESENT": false
  },
  "legacyServiceAccountWarning": null
}
```

Если `configured: false` — что-то с env vars не так. Проверить `vercel env ls production`.

### B. Купить тестовую этикетку

Vladimir-у самому через `/shipping` купить одну этикетку. В Buy Report Dialog должно показать:

- Счётчик **`On Drive: 1/1`** зелёным
- На карточке заказа: **`PDF: ✓ on Drive`** зелёным
- Кнопка `Open PDF` ведёт на `https://drive.google.com/file/d/...`
- **НЕ должно быть** warning баннера

### C. Проверить папку на Drive

Открыть на Drive: https://drive.google.com/drive/folders/1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt

Внутри должна быть папка `MM Month / DD / Channel /` с PDF файлом по схеме `(EDD ... | DL ...) ... .pdf`.

### D. Cron back-fill активен

Vercel Dashboard → Project → Cron Jobs → должно быть **5 cron jobs** (4 старых + новый `/api/cron/drive-backfill` с schedule `*/15 * * * *`). Status: `Active`. После следующего тика (в течение 15 минут) Last invocation покажет success.

### E. Back-fill старых этикеток

Если в БД есть `ShippingPlanItem` с `status='bought'` и `labelPdfUrl` содержащим `/api/shipping/label-pdf` (то есть proxy fallback от прошлых покупок до фикса) — запустить manual back-fill:

```bash
curl -X POST https://<your-vercel-domain>/api/integrations/drive-backfill \
  -H "Cookie: <admin-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"lookbackDays": 365}'
```

Или через UI на `/admin/integrations` нажать кнопку `Run now` с lookback `1 year`.

Endpoint вернёт `{found, uploaded, errors, skipped}`. Все `uploaded` orders теперь имеют Drive webViewLink в БД.

---

## ШАГ 6 — Cleanup .env.local (опционально, для безопасности)

После того как всё работает, можно удалить локальный файл с секретами (он больше не нужен — Vercel хранит):

```bash
# Опционально — если Vladimir не планирует тестить локально через npm run dev
rm /Users/amazon/ss-control-center/ss-control-center/.env.local
```

Если планирует — оставить, файл уже в .gitignore. Утечка маловероятна.

---

## ROLLBACK (если что-то сломалось)

В крайнем случае:
1. `vercel rollback` — откатить deploy к предыдущей версии
2. Удалить добавленные env vars (для чистоты): `vercel env rm GOOGLE_OAUTH_CLIENT_ID production -y` и т.д.

Старые покупки этикеток продолжат работать через proxy fallback — данные не теряются. Drive upload просто не будет работать пока не починим.

---

## ACCEPTANCE CRITERIA

После выполнения всех шагов:

- [ ] `vercel env ls production | grep GOOGLE` показывает 4 переменные `GOOGLE_OAUTH_*` + `GOOGLE_DRIVE_ROOT_FOLDER`. Нет `GOOGLE_SERVICE_ACCOUNT_JSON`.
- [ ] `GET /api/integrations/drive-status` возвращает `configured: true`.
- [ ] После покупки тестовой этикетки модалка показывает `On Drive: 1/1` зелёным.
- [ ] На Drive в `Shipping Labels/...` появился новый PDF файл.
- [ ] `vercel.json` содержит 5 cron entries (был 4 + новый `drive-backfill`).
- [ ] `/admin/integrations` показывает блок Drive Backfill с кнопкой `Run now`.
- [ ] `docs/wiki/google-drive-setup.md` описывает OAuth flow (не service account).
- [ ] `docs/wiki/drive-backfill.md` создана.

---

**End of master prompt** — 2026-05-15
