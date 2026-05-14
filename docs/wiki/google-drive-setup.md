# ☁️ Google Drive — настройка загрузки PDF этикеток

## Зачем
SS Control Center на Vercel — serverless, локальная файловая система эфемерная (файл прожил 1 запрос и испарился). Чтобы PDF этикетки сохранялись по структуре `Shipping Labels / MM Month / DD / Channel /` (как раньше делал n8n), нужен **service account** Google с правом записи в эту папку.

Без настройки этикетки всё равно не теряются — в БД сохраняется Veeqo URL (label_url из ответа покупки), и кнопка "Open PDF" в модалке отчёта открывает PDF у Veeqo. Но удобной папочной структуры на Drive не будет.

## Что нужно сделать (одноразовая настройка)

### 1. Создать GCP service account
1. Зайти на [console.cloud.google.com](https://console.cloud.google.com)
2. Создать (или выбрать) проект
3. **APIs & Services → Library → Google Drive API → Enable**
4. **IAM & Admin → Service Accounts → Create service account**
   - Name: `ss-control-center-drive`
   - Skip "Grant access" steps (необязательно)
   - Done
5. Открыть созданный аккаунт → **Keys → Add Key → Create new key → JSON**
6. Скачается файл `your-project-12345.json` — это credentials

### 2. Расшарить Drive папку с service account
1. Открыть в браузере папку **Shipping Labels** на Google Drive (ID: `1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt`)
2. Правый клик → **Share**
3. Вставить email service account'а (он внутри JSON: `client_email`, выглядит как `ss-control-center-drive@your-project.iam.gserviceaccount.com`)
4. Роль: **Editor**
5. Send

### 3. Добавить credentials в Vercel env
Vercel **не любит многострочные env-vars** — JSON может слететь. Поэтому закодируй в base64:

```bash
base64 -i your-project-12345.json | pbcopy
```
(скопирует одну длинную строку в буфер)

В Vercel:
1. Project → **Settings → Environment Variables**
2. Add:
   - Key: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Value: вставь base64-строку
   - Environments: Production + Preview (Development если нужно локально)
3. Save
4. Redeploy (Deployments → … → Redeploy)

> Код понимает обе формы: и raw JSON, и base64. Если пишешь в `.env` локально — можно raw JSON в одну строку.

### 4. Проверка
После redeploy купи одну этикетку:
- В модалке отчёта `PDF saved` должен показать **1/1**
- Ссылка "Open PDF" откроет файл на Drive
- Файл лежит в `Shipping Labels / MM Month / DD / Channel /`

## Что в коде
- [src/lib/google-drive.ts](../../ss-control-center/src/lib/google-drive.ts) — auth + папочная иерархия + upload
- [src/app/api/shipping/buy/route.ts](../../ss-control-center/src/app/api/shipping/buy/route.ts) — порядок: Drive → local disk → Veeqo URL fallback

## Если что-то пошло не так
В Vercel function logs искать строки `[drive]`:
- `GOOGLE_SERVICE_ACCOUNT_JSON not set` → env-var не дошёл, проверь Vercel настройки
- `service account parse/auth failed` → JSON битый, перекодируй base64 заново
- `getOrCreateFolder() failed` → service account не имеет доступа к папке, проверь шеринг
- `uploadLabelPdf failed` → API quota / permissions issue

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md), [Buy Flow](shipping-labels-page-v1.md)
- **Используется в:** `/api/shipping/buy` после успешной покупки
- **Связан с:** [Veeqo API](veeqo-api.md) (label_url из ответа на purchase)

## История
- 2026-05-14: Реализован Drive upload в ss-control-center. Раньше
  работал только n8n workflow; новый Next.js-приложение писал PDF в
  `public/labels/...` локально, что на Vercel разваливалось.
