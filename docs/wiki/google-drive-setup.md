# ☁️ Google Drive — настройка загрузки PDF этикеток

> ⚠️ **2026-05-15 — статья переписана.** Раньше она описывала service account setup, но это не работает с личным Gmail (kuzy.vladimir@gmail.com): service accounts на consumer Drive не имеют storage quota. Код переключён на **OAuth2 refresh token** ещё во время sprint 2026-05-14, но эта статья и `.env.example` остались с устаревшими инструкциями. Это и было причиной почему этикетки не сохранялись на Drive в production.

## Зачем
SS Control Center на Vercel — serverless, локальная файловая система эфемерная (`writeFileSync('public/labels/...')` живёт 1 запрос). Чтобы PDF этикетки сохранялись по структуре `Shipping Labels / MM Month / DD / Channel /` (как раньше делал n8n), нужен доступ на запись в эту папку.

**Текущая реализация (с 2026-05-14):** OAuth2 refresh token от имени `kuzy.vladimir@gmail.com` (владелец папки). Так же как делает n8n workflow.

Без настройки этикетки **всё равно не теряются**: в БД сохраняется fallback URL `/api/shipping/label-pdf?shipmentId=X` (наш прокси к Veeqo с авторизацией), кнопка "Open PDF" в модалке работает. Но папочной структуры на Drive нет.

---

## Что нужно сделать (одноразовая настройка)

### Шаг 1 — Создать OAuth Client ID в Google Cloud Console

1. Зайти на [console.cloud.google.com](https://console.cloud.google.com)
2. Создать (или выбрать) проект — например `ss-control-center`
3. **APIs & Services → Library → Google Drive API → Enable**
4. **APIs & Services → OAuth consent screen**:
   - User Type: **External**
   - App name: `SS Control Center`
   - User support email: `kuzy.vladimir@gmail.com`
   - Developer email: `kuzy.vladimir@gmail.com`
   - Scopes — добавить `https://www.googleapis.com/auth/drive.file` (или `drive` если хочешь больше прав)
   - Test users — добавить `kuzy.vladimir@gmail.com`
   - Save
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `SS Control Center Drive`
   - Authorized redirect URIs — добавить **`https://developers.google.com/oauthplayground`**
   - Create
6. **Сохрани Client ID и Client Secret** — они понадобятся в шагах 2 и 3.

### Шаг 2 — Получить refresh token через OAuth Playground

1. Открыть [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
2. Справа сверху — иконка шестерёнки → **Use your own OAuth credentials** (галочка)
3. Вставить **OAuth Client ID** и **OAuth Client secret** из шага 1.6
4. Слева — в поле "Input your own scopes" вставить:
   ```
   https://www.googleapis.com/auth/drive.file
   ```
5. Нажать **Authorize APIs** → залогиниться **`kuzy.vladimir@gmail.com`** (важно — именно владелец папки) → разрешить
6. После редиректа нажать **Exchange authorization code for tokens**
7. **Скопировать `refresh_token`** из правой панели — он понадобится в шаге 3.

> 💡 Refresh token обычно бессрочный. Но если приложение в статусе "Testing" на OAuth consent screen, токены могут истекать через 7 дней. Чтобы избежать — на OAuth consent screen переключить **Publishing status → In production** (для personal use это не требует verification).

### Шаг 3 — Установить env vars в Vercel

В Vercel → Project → **Settings → Environment Variables** добавить (или обновить):

| Key | Value |
|-----|-------|
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID из шага 1.6 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client Secret из шага 1.6 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | refresh_token из шага 2.7 |
| `GOOGLE_DRIVE_ROOT_FOLDER` | `1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt` (ID папки Shipping Labels) |

Environments: **Production + Preview** (обязательно), **Development** опционально.

**Удалить старую** `GOOGLE_SERVICE_ACCOUNT_JSON` если она там есть — не используется.

После сохранения — **Deployments → … → Redeploy** последний production деплой (env vars применяются только при redeploy).

### Шаг 4 — Локальный `.env` (для dev окружения)

В `ss-control-center/.env` (он в `.gitignore`):

```
GOOGLE_OAUTH_CLIENT_ID=<тот же>
GOOGLE_OAUTH_CLIENT_SECRET=<тот же>
GOOGLE_OAUTH_REFRESH_TOKEN=<тот же>
GOOGLE_DRIVE_ROOT_FOLDER=1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt
```

### Шаг 5 — Проверка

После redeploy купить одну этикетку:
- В модалке **Buy report** счётчик `PDF saved` должен показать **1/1** (зелёным)
- `PDF source: drive` (зелёным)
- Ссылка "Open PDF" откроет файл на Drive в браузере
- Файл лежит в `Shipping Labels / 05 May / 15 / Amazon / (EDD ... | DL ...) ... .pdf`

Если что-то не так — раздел "Если не работает" ниже.

---

## Что в коде

- [`src/lib/google-drive.ts`](../../ss-control-center/src/lib/google-drive.ts) — auth + папочная иерархия + upload. Главные функции:
  - `getDriveClient()` — лениво создаёт OAuth2 клиент, возвращает `{ok, drive}` или `{ok: false, reason}`
  - `uploadLabelPdf({folderSegments, filename, pdf})` — основная upload функция, возвращает `{ok, result: {fileId, webViewLink}}` или `{ok: false, reason}`
  - `getDriveStatus()` — диагностика для `/api/integrations` (показывает в admin UI настроена ли интеграция)
- [`src/app/api/shipping/buy/route.ts`](../../ss-control-center/src/app/api/shipping/buy/route.ts) — порядок fallback: Drive → local disk (только dev) → Veeqo proxy URL
- [`src/app/api/shipping/label-pdf/route.ts`](../../ss-control-center/src/app/api/shipping/label-pdf/route.ts) — fallback прокси (используется когда Drive недоступен)
- [`src/app/api/shipping/label-drive-retry/route.ts`](../../ss-control-center/src/app/api/shipping/label-drive-retry/route.ts) — retry endpoint для повторной загрузки уже купленных этикеток на Drive (полезно если Drive был не настроен в момент покупки)

---

## Если не работает

### В модалке после покупки — "PDF source: proxy · Drive: ..."

Это значит что в response от `/api/shipping/buy` пришло `pdfSource: "proxy"` и `driveError` с причиной. Сама ошибка скажет правду:

| Сообщение | Что значит | Что делать |
|-----------|-----------|-----------|
| `GOOGLE_OAUTH_CLIENT_ID, ... not set` | Одна или несколько env vars не дошли до Vercel | Проверить Settings → Environment Variables. Не забыть Redeploy после добавления. |
| `OAuth client init failed: invalid_client` | Неверный client_id или client_secret | Перепроверить значения в Vercel (без пробелов в начале/конце) |
| `invalid_grant` | Refresh token истёк или отозван | Перевыпустить refresh token через OAuth Playground (шаг 2). Если приложение в "Testing" — переключить на "In production". |
| `Could not resolve "MM Month"...` | Папка Shipping Labels не существует или доступ запрещён | Проверить что в `GOOGLE_DRIVE_ROOT_FOLDER` правильный ID. Проверить что залогиненный пользователь (владелец refresh token) имеет доступ к папке. |
| `Drive create returned without id or webViewLink` | Странный ответ от API, может быть quota | Проверить квоту Google Drive |

### В Vercel function logs искать строки `[drive]` или `[buy]`

```
Vercel Dashboard → Project → Logs → фильтр по "drive" или "buy"
```

Конкретные строки:
- `[drive] getOrCreateFolder(name) failed: <reason>` — конкретный сегмент пути не создан
- `[drive] uploadLabelPdf failed: <reason>` — finalstage upload не прошёл
- `[buy] Drive upload failed for <order>: <reason>` — Drive вернул `ok: false`

### Retry для уже купленных этикеток

Если ты купил этикетки до настройки Drive, и они в БД с `labelPdfUrl` = `/api/shipping/label-pdf?...`:

```
POST /api/shipping/label-drive-retry
Body: { "shipmentId": "1196697352" }
Auth: Bearer token (admin)
```

Endpoint заново скачает PDF из Veeqo и загрузит на Drive. Обновит `labelPdfUrl` на Drive webViewLink.

---

## История

- **2026-05-15** — статья переписана с service account на OAuth. Корневая причина почему этикетки не загружались в production: `.env.example` и эта статья описывали service account setup (устаревшая попытка реализации), а код требовал `GOOGLE_OAUTH_*` переменные.
- **2026-05-14** — реализован Drive upload в ss-control-center. Раньше работал только n8n workflow; новое Next.js приложение писало PDF в `public/labels/...` локально, что на Vercel разваливалось из-за эфемерной файловой системы.
- **2026-05-14** — первая попытка с service account отброшена: личный Gmail (kuzy.vladimir@gmail.com) не даёт service account-у storage quota, нужен Workspace Shared Drive которого у Vladimir нет. Переход на OAuth refresh token.

## 🔗 Связи

- **Часть:** [Shipping Labels](shipping-labels.md), [Shipping Labels Page v1](shipping-labels-page-v1.md)
- **Используется в:** `/api/shipping/buy` после успешной покупки этикетки
- **Связан с:** [Veeqo API](veeqo-api.md), [Veeqo API Quirks §10](veeqo-api-quirks.md) (Vercel ephemeral disk)
- **Алгоритм:** [MASTER_PROMPT v3.3](../MASTER_PROMPT_v3.3.md) §8 (структура папок)
