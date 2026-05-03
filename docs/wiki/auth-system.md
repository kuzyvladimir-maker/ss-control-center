# 🔐 Auth System — Control Center UI Login

## Суть
Система входа в сам UI Control Center (НЕ путать с [External API Auth](external-api-auth.md) — там Bearer token для внешних потребителей).

Реализована **своя** auth, не NextAuth. Простая, достаточная для single-tenant админки.

## Поток логина

```
POST /api/auth/login { username, password }
  ↓
prisma.user.findUnique({ username })      ← Turso (prod) / dev.db (local)
  ↓
verifyPassword(password, user.passwordHash)  ← SHA-256 + salt
  ↓
createSessionToken()                       ← HMAC на NEXTAUTH_SECRET
  ↓
Set-Cookie: sscc-session=<token>; HttpOnly; Secure; SameSite=Lax; Max-Age=30d
```

## Хеширование паролей

`src/lib/auth.ts`:
- `hashPassword(password)` → `"<salt_hex>:<sha256(salt+password)_hex>"`
- `verifyPassword(password, stored)` → split по `:`, хеш заново, `timingSafeEqual`
- Salt: 16 случайных байт (hex-encoded)

**Примечание:** SHA-256 + salt — не лучший вариант (bcrypt/argon2 надёжнее против брутфорса), но для админки одного пользователя с сильным паролем этого достаточно.

## Session tokens

Формат: `sscc:<issuedAtMs>:<random8hex>:<sha256(payload+NEXTAUTH_SECRET)>`

- Подпись: SHA-256 от payload + `NEXTAUTH_SECRET`
- Живёт 30 дней (`SESSION_MAX_AGE_MS`)
- Хранится в HttpOnly cookie `sscc-session`
- Verify: пересчитать хеш и сравнить `timingSafeEqual`

## Регистрация

`POST /api/auth/register` — создаёт bootstrap-юзера.

**Закрывается автоматически** как только в таблице `User` появилась первая запись. Разблокировка — только через env `SSCC_ALLOW_REGISTRATION=true` (не для прода).

Вывод: второго админа через UI создать нельзя. Только через [scripts/create-admin.ts](../../ss-control-center/scripts/) (если создан) или вручную SQL в Turso.

## Сброс пароля

Отдельной страницы "Forgot password" НЕТ. Сброс — только через скрипт `scripts/reset-password.ts` (создан в рамках инцидента 2026-04-18, см. `CLAUDE_CODE_PROMPT_AUTH_500_FIX.md`).

Скрипт:
1. Читает `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` из `.env`
2. Подключается к Turso напрямую через `@libsql/client` (минует Prisma)
3. Генерирует случайный 16-символьный пароль
4. Хеширует через ту же функцию `hashPassword` из `src/lib/auth.ts`
5. `UPDATE User SET passwordHash = ? WHERE username = ?`
6. Печатает новый пароль в stdout

## Env vars которые нужны

| Var | Где | Зачем |
|-----|-----|-------|
| `TURSO_DATABASE_URL` | Vercel prod + локально | Prisma client → libSQL |
| `TURSO_AUTH_TOKEN` | Vercel prod + локально | Авторизация Turso |
| `NEXTAUTH_SECRET` | Vercel prod + локально | Подпись session cookies (название историческое, NextAuth не используется) |
| `DATABASE_URL` | Только локально, fallback | `file:./dev.db` |
| `SSCC_ALLOW_REGISTRATION` | Опционально | `"true"` открывает `/register` заново |

**Мёртвая переменная:** `AUTH_PASSWORD` в локальном `.env` ничем не используется — реликт, можно удалить.

## Middleware

`src/middleware.ts` — проверка `sscc-session` cookie на всех путях кроме `/login`, `/api/auth/*`, статики.
При отсутствии / невалидной подписи → redirect на `/login`.

## Известные проблемы

- **UI показывает "Network error" на любую ошибку с бэка.** Код логина на `src/app/login/page.tsx` не разбирает `response.status` — любой не-2xx даёт generic "Network error", хотя на самом деле может быть 401, 500 или что угодно. Ждёт правки: при `!response.ok` показывать `data.error || "Server error (${status})"`. Баг проявил себя в инциденте 2026-04-18 (500 маскировался под "Network error").

## 🔗 Связи

- **Зависит от:** [Database Schema](database-schema.md) (модель `User`), Turso cloud DB
- **Параллельно:** [External API Auth](external-api-auth.md) — для внешних клиентов (другой механизм: Bearer token)
- **Связан с:** [Архитектура проекта](project-architecture.md), [Деплой на Vercel](deploy-to-vercel-plan.md)

## История

- **2026-04-18:** Статья создана в ходе инцидента "500 на `/api/auth/login`". Диагностика проведена в Claude chat через Claude in Chrome + чтение кода проекта. См. `CLAUDE_CODE_PROMPT_AUTH_500_FIX.md` — инструкция для Claude Code по починке и сбросу пароля.
