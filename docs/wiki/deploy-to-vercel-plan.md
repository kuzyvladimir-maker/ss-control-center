# План: Деплой на Vercel + миграция на Postgres

## Суть
План публикации SS Control Center в интернете, чтобы Владимир мог пользоваться им с любого компьютера/телефона. Сейчас проект работает только на `localhost:3000` на Mac. План отложен — выполнить когда будет ~1ч 15м свободного времени.

**Статус:** 📌 ОТЛОЖЕНО (2026-04-10). Вернуться когда Стадия A (Google Cloud + localhost) уже работает и нужно вынести в прод.

## Зачем
- Заходить с ноутбука/телефона/iPad на рабочий URL
- Cron для синков работает 24/7 (не только когда Mac включён)
- Никакого `npm run dev` перед работой
- Легче давать доступ другим людям (сотрудники, n8n, Claude-агент)

---

## Подводные камни

### 🔴 SQLite не выживет на Vercel
Vercel — serverless, функции запускаются в изолированных контейнерах без постоянного диска. Наш `dev.db` на файловой системе **не сохраняется** между запросами — любой `prisma.write()` потеряется через секунды. Это главный блокер.

**Решение:** мигрировать Prisma на Postgres.

### Варианты хостинга Postgres (оба бесплатно)
| Сервис | Плюсы | Минусы |
|---|---|---|
| **Neon** | Serverless, auto-scale, 0.5 GB free, бесплатно навсегда | Новый игрок |
| **Supabase** | Более известный, 500 MB free, auth/storage если понадобятся | Менее чистый Postgres (всякие обёртки) |

**Рекомендация:** Neon — проще и ближе к чистому Postgres. Если понадобится auth/storage в будущем — мигрировать на Supabase легко.

### Нет GMAIL_CLIENT_ID для OAuth
Перед деплоем должна быть пройдена **Стадия A** — Google Cloud Console setup на localhost. Иначе на проде тоже не будет работать.

---

## Полный таймлайн (~1ч 15м)

| # | Этап | Время | Блокирует Владимира? |
|---|---|---|---|
| 1 | Создать Neon аккаунт через GitHub | 3 мин | Да |
| 2 | Создать проект в Neon, скопировать `DATABASE_URL` | 2 мин | Да |
| 3 | Обновить `prisma/schema.prisma`: `provider = "postgresql"` | 2 мин | Нет |
| 4 | `prisma migrate dev --name init_postgres` | 3 мин | Нет |
| 5 | Локально протестировать что всё работает с Postgres | 5 мин | Нет |
| 6 | Создать Vercel аккаунт через GitHub | 2 мин | Да |
| 7 | Push на `origin/main` (или новая ветка `deploy`) | 1 мин | Нет |
| 8 | Подключить Vercel к GitHub репо | 3 мин | Да |
| 9 | Добавить env vars в Vercel UI (~25 штук) | 10 мин | Частично |
| 10 | Первый build на Vercel + разбор ошибок (всегда что-то ломается) | 15-30 мин | Нет |
| 11 | Скопировать финальный Vercel URL (напр. `ss-control-center.vercel.app`) | 1 мин | Нет |
| 12 | Google Cloud Console → Credentials → добавить новый Authorized redirect URI: `https://<vercel-url>/api/auth/gmail/callback` | 2 мин | Да |
| 13 | Обновить `GMAIL_REDIRECT_URI` в Vercel env на прод URL | 1 мин | Нет |
| 14 | Финальный тест: зайти с телефона → Settings → Connect Gmail для всех магазинов | 5 мин | Да |
| **Итого** | | **~1ч 15м** | **Активно ~30 мин** |

---

## Env vars которые надо перенести в Vercel

Из `.env`:
```
DATABASE_URL (новый — из Neon, НЕ старый SQLite)
NEXTAUTH_SECRET
SSCC_API_TOKEN
ANTHROPIC_API_KEY
VEEQO_API_KEY
VEEQO_BASE_URL
SELLBRITE_ACCOUNT_TOKEN
SELLBRITE_SECRET_KEY
SELLBRITE_BASE_URL
GOOGLE_SHEETS_ID
GOOGLE_DRIVE_ROOT_FOLDER
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ORIGIN_LAT
ORIGIN_LON
ORIGIN_CITY
ORIGIN_STATE
AMAZON_SP_MARKETPLACE_ID
AMAZON_SP_ENDPOINT
AMAZON_SP_CLIENT_ID_STORE1
AMAZON_SP_CLIENT_SECRET_STORE1
AMAZON_SP_REFRESH_TOKEN_STORE1
AMAZON_SP_CLIENT_ID_STORE2
AMAZON_SP_CLIENT_SECRET_STORE2
AMAZON_SP_REFRESH_TOKEN_STORE2
STORE1_NAME
STORE2_NAME
STORE3_NAME
STORE4_NAME
STORE5_NAME
GMAIL_CLIENT_ID      ← новый, добавленный в Стадии A
GMAIL_CLIENT_SECRET  ← новый, добавленный в Стадии A
GMAIL_REDIRECT_URI   ← https://<vercel-url>/api/auth/gmail/callback
```

**НЕ переносить:** локальные пути, `DATABASE_URL` со старым `file:./dev.db`.

---

## Миграция данных из SQLite в Postgres

Сейчас `dev.db` практически пустая — там только схема, реальных данных нет. Поэтому миграция проста:

1. Сменить provider в `schema.prisma` на postgresql
2. Удалить старые миграции из `prisma/migrations/` (они SQLite-specific) ИЛИ новый provider автоматически создаст новые
3. `prisma migrate dev --name init` создаст Postgres таблицы
4. Всё

**Если к моменту деплоя в dev.db появятся важные данные** — добавить шаг экспорта:
- `sqlite3 dev.db .dump > backup.sql` → трансформировать → загрузить в Postgres
- Или написать скрипт на Node: читать всё через Prisma (старый клиент), писать через новый

---

## Почему откладываем

Сегодня (2026-04-10) решили не делать в одной сессии — ~1ч 15м слишком долго. Вместо этого делаем **Стадию A** (Google Cloud Console + localhost), чтобы кнопочный flow заработал на Mac, а деплой — отдельной сессией.

---

## Связанные файлы
- `src/lib/gmail-api.ts` — OAuth логика, `GMAIL_CLIENT_ID` + `GMAIL_REDIRECT_URI`
- `src/app/api/auth/gmail/` — OAuth init + callback
- `prisma/schema.prisma` — provider для миграции
- `.env` / `.env.example` — список env vars для Vercel
- [Gmail API](gmail-api.md) — общий обзор интеграции
- [External API Auth](external-api-auth.md) — Bearer токен для публичного API

## История
- 2026-04-10: План создан на основе обсуждения в сессии. Отложен в пользу Стадии A (localhost setup). Вернуться когда будет свободный час.
