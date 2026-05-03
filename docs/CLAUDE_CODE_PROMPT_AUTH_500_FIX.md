# CLAUDE CODE PROMPT — Auth 500 Fix + Password Recovery

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-04-18
> **Prepared by:** Vladimir (via diagnostic в Claude chat)
> **Execution mode:** поэтапно, commit после каждого этапа где меняем код/миграции
> **Priority:** 🔥 CRITICAL — Владимир не может войти в прод

---

## 🎯 КОНТЕКСТ И ДИАГНОЗ

Владимир не может войти на `https://salutemsolutions.info/login`. В чате мы уже провели диагностику через Claude in Chrome и чтение файлов проекта. Вот что известно **точно**:

### Что мы уже установили

1. **Фронтенд живой** — страница `/login` грузится, SSL ок, DNS ок.
2. **API роут `/api/auth/login` возвращает `500 Internal Server Error`** на любой пароль (мы проверили заведомо неверным `diagnostic_not_real_pwd`). То есть проблема возникает **до** проверки пароля.
3. **Подпись ошибки на UI ("Network error") некорректна** — это косметический баг клиента, который любой не-2xx маскирует под "Network error". Это не сетевая ошибка, это 500 с бэка.
4. **Хостинг:** Vercel (`projectId: prj_28wvae7xPg4Y8j7625sSWBxfYuX5`, team `team_wbZLiGFgavnxMBYJeFkD8fqr`).
5. **БД в проде:** Turso (cloud libSQL), URL `libsql://ss-control-center-kuzyvladimir-maker.aws-us-east-1.turso.io`. Локально — `dev.db` через тот же `@prisma/adapter-libsql`.
6. **Auth:** своя реализация (НЕ NextAuth), в `src/app/api/auth/login/route.ts`. Флоу:
   - принять `{ username, password }`
   - `prisma.user.findUnique({ where: { username: ... } })` ← **здесь всё падает**
   - `verifyPassword(password, user.passwordHash)` (SHA-256 + salt, `src/lib/auth.ts`)
   - выдать session cookie `sscc-session`, подписанный `NEXTAUTH_SECRET`
7. **Пароль** хранится как хеш в таблице `User` в Turso. Переменная `AUTH_PASSWORD` в локальном `.env` — мёртвая, код её не использует.
8. **Регистрация** (`/api/auth/register`) закрыта, пока `prisma.user.count() > 0` и `SSCC_ALLOW_REGISTRATION !== "true"`. Значит создать нового админа через UI мы не можем.

### Гипотезы причины 500 (в порядке убывания вероятности)

| # | Причина | Как проверить |
|---|---------|---------------|
| 1 | На Vercel не выставлены `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — и Prisma падает на коннекте к БД | `vercel env ls production` |
| 2 | `TURSO_AUTH_TOKEN` на Vercel истёк / отозван | `turso db tokens list` + логи Vercel |
| 3 | `NEXTAUTH_SECRET` на Vercel не выставлен — хотя логин упадёт ПОСЛЕ верификации пароля (в `createSessionToken`), всё равно проверить | `vercel env ls production \| grep NEXTAUTH` |
| 4 | На Turso не применены миграции — нет таблицы `User` | `turso db shell ... .tables` |
| 5 | `@libsql/client` / `@prisma/adapter-libsql` ломаются в runtime Vercel (bundling/edge issue) | стек-трейс в логах |

**Основная вероятность: #1 или #2** — они встречаются в 80% таких кейсов, когда локально работает, а на Vercel 500.

---

## 🎯 ЦЕЛЬ ПРОМПТА

**1)** Точно диагностировать причину 500 на `/api/auth/login` в проде.
**2)** Починить её.
**3)** Если Владимир не помнит пароль — **сбросить пароль** юзера `kuzy.vladimir@gmail.com` на новый известный (через скрипт, пишущий напрямую в Turso через `@libsql/client`, используя `hashPassword` из `src/lib/auth.ts`).
**4)** Проверить что вход работает end-to-end и вернуть Владимиру новый пароль **в финальном сообщении в чат Claude Code** (не в git, не в файл который коммитится).

---

## ⛔ БЕЗОПАСНОСТЬ — НЕ НАРУШАТЬ

1. **НИКОГДА** не коммить `.env`, `.env.vercel.production`, `.env.backup`, и любые файлы с реальными ключами. Проверь `.gitignore` до первой команды записи.
2. **НИКОГДА** не печатай в git-комментариях / PR-описаниях значения токенов, паролей, secret'ов. В любых `console.log` — только маскированные версии (`token.slice(0,6) + "..."`).
3. Файл с выгруженными Vercel env (`.env.vercel.production`) создавай **ТОЛЬКО** в `/tmp` или добавь в `.gitignore` до создания.
4. Новый пароль (если делаем reset) — генерировать **локально**, не отправлять ни в какой внешний сервис, выводить в `stdout` Claude Code ОДИН раз, в конце работы.
5. `TURSO_AUTH_TOKEN` и `NEXTAUTH_SECRET` в ЛЮБЫХ логах — **маскировать**.
6. Если любая команда требует `sudo` или установки глобальных пакетов — **сначала спроси** Владимира через сообщение в чате Claude Code. Не устанавливай молча.

---

## 📋 PRE-FLIGHT — проверить окружение

До всего остального — убедись что есть всё нужное. Если чего-то нет, либо установи (см. ниже), либо скажи Владимиру что именно поставить и жди.

```bash
# 1. Мы в правильной папке
pwd   # должно быть /Users/vladimirkuznetsov/SS Command Center/ss-control-center
ls .vercel/project.json  # должен существовать

# 2. Vercel CLI
vercel --version || echo "NEED: npm i -g vercel"

# 3. Turso CLI
turso --version || echo "NEED: brew install tursodatabase/tap/turso"

# 4. Node + npm доступны и зависимости установлены
node --version
npm ls @libsql/client @prisma/adapter-libsql || echo "NEED: npm install"
```

**Если Vercel CLI не залогинен:** `vercel whoami` должно вернуть логин Владимира. Если `Error: Not authenticated` → `vercel login` (GitHub). Только с согласия.

**Если Turso CLI не залогинен:** `turso auth whoami`. Если нет — `turso auth login`. Только с согласия.

---

## 🔍 STEP 1 — Вытащить РЕАЛЬНЫЙ стек ошибки с Vercel

Это главное. Дальше идём не гадая, а по факту.

```bash
# Последние логи прода за 30 минут. Фильтруем по роуту логина.
vercel logs --prod --since 30m | grep -iE "auth/login|prisma|libsql|turso|ECONNREFUSED|UNAUTHORIZED|PrismaClientInitialization" | head -100
```

Если `vercel logs` не даёт достаточно — зайди в Vercel Dashboard → Project → Logs → фильтр `path:/api/auth/login` + `status:500`.

**Что ищем:**
- `PrismaClientInitializationError` → БД не подключается
- `LibsqlError: SERVER_ERROR: the server cannot currently handle the request` → Turso либо down, либо токен
- `LIBSQL_AUTH_REQUIRED` / `Unauthorized` → токен истёк / не выставлен
- `Error: DATABASE_URL is not set` / `TURSO_DATABASE_URL is not set` → env var отсутствует
- `Table 'User' does not exist` → миграции не применены
- `Cannot find module '@prisma/adapter-libsql'` → сборочная проблема

**Зафиксируй точный стек в сообщении Владимиру перед тем как что-то менять.** Если непонятно — спроси Владимира прежде чем действовать.

---

## 🔍 STEP 2 — Сравнить env vars: локально vs Vercel Production

```bash
# Выгрузи прод env в ВРЕМЕННЫЙ файл в /tmp (не в репо!)
vercel env pull /tmp/vercel.production.env --environment=production

# Проверь что файл НЕ попал в репо
git status /tmp/vercel.production.env 2>&1 | head  # должен сказать что вне репо

# Сравни ключевые переменные
echo "=== Ключевые для Auth/DB ==="
for key in TURSO_DATABASE_URL TURSO_AUTH_TOKEN NEXTAUTH_SECRET DATABASE_URL NODE_ENV; do
  local_val=$(grep "^${key}=" .env | cut -d= -f2- | head -c 20)
  prod_val=$(grep "^${key}=" /tmp/vercel.production.env | cut -d= -f2- | head -c 20)
  echo "${key}:"
  echo "  local: ${local_val}..."
  echo "  prod:  ${prod_val}..."
done
```

**Не выводи полные значения!** Только первые 20 символов для сравнения.

**Что смотрим:**
- `TURSO_DATABASE_URL` должен начинаться с `libsql://ss-control-center-kuzyvladimir-maker.aws-us-east-1.turso.io` — **идентично** в обоих местах.
- `TURSO_AUTH_TOKEN` должен быть JWT (`eyJ...`) — **идентично** в обоих местах (иначе один из токенов устаревший).
- `NEXTAUTH_SECRET` должен быть **непустой** на Vercel. Может отличаться от локального.
- На Vercel **не должно быть** `DATABASE_URL=file:./dev.db` — это локальная SQLite, на serverless упадёт.

**После проверки:**

```bash
# Удали выгруженный env
rm /tmp/vercel.production.env
```

---

## 🔍 STEP 3 — Проверить Turso DB: коннект, таблицы, юзер

```bash
# Подключись к прод БД через Turso CLI
# Имя БД: ss-control-center-kuzyvladimir-maker
turso db shell ss-control-center-kuzyvladimir-maker

# Внутри shell выполни:
.tables
# Должно показать: User, Account, CsCase, ShippingPlan, ShippingPlanItem, ...
# Если нет таблицы "User" — миграции не применены → переходим в ВЕТКУ A ниже

SELECT username, displayName, substr(passwordHash, 1, 10) || '...' AS hash_preview, createdAt
FROM User;
# Должна быть хотя бы одна запись с username = 'kuzy.vladimir@gmail.com'

.quit
```

**Варианты результата:**

- **(a)** Таблица `User` есть, запись `kuzy.vladimir@gmail.com` есть, хеш выглядит нормально (формат `salt:hash`, оба hex) → **проблема в env vars или в runtime сборке**, идём в STEP 4.
- **(b)** Таблица `User` есть, но записи нет (или username другой — например `admin`) → узнай правильный username, переходи в STEP 5 (reset password на существующего).
- **(c)** Таблицы `User` нет → переходи в ВЕТКУ A ниже.

### ВЕТКА A — если миграции не применены на Turso

```bash
# Убеждаемся что локальная Prisma схема актуальна
npx prisma validate

# Применяем миграции на Turso (ВНИМАНИЕ: для libsql нужен специальный способ)
# Prisma Migrate не работает напрямую с libsql — используем db push
DATABASE_URL="$(grep '^TURSO_DATABASE_URL=' .env | cut -d= -f2-)?authToken=$(grep '^TURSO_AUTH_TOKEN=' .env | cut -d= -f2-)" \
  npx prisma db push --skip-generate
```

**Важно:** после `db push` на Turso → таблицы пустые. Пользователя надо создать заново → переходи в STEP 5, ветка "создать юзера заново".

---

## 🔧 STEP 4 — Починить env vars (если диагноз: они)

Если в STEP 2 обнаружили что на Vercel не хватает `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` или `NEXTAUTH_SECRET`:

```bash
# Добавить недостающую переменную. Команда попросит ввести значение
# (intereactively, чтобы не светить в истории).
vercel env add TURSO_DATABASE_URL production
# Вставь значение из локального .env БЕЗ кавычек. Повтори для остальных.

vercel env add TURSO_AUTH_TOKEN production
vercel env add NEXTAUTH_SECRET production

# После добавления env vars нужно передеплоить!
vercel --prod --force
# Или через GitHub Actions если так настроено — сделай пустой коммит "chore: redeploy after env fix"
```

Если Vercel переменные в порядке, но `TURSO_AUTH_TOKEN` на Vercel отличается от локального ИЛИ вообще не валиден — сгенерируй новый:

```bash
turso db tokens create ss-control-center-kuzyvladimir-maker --expiration none
# Обнови и локальный .env, и Vercel env
vercel env rm TURSO_AUTH_TOKEN production
vercel env add TURSO_AUTH_TOKEN production  # вставь новый
# Обнови локальный .env: str_replace старого токена на новый
vercel --prod --force
```

**После передеплоя (~2 мин)** — проверь через `curl`:

```bash
curl -i -X POST https://salutemsolutions.info/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"kuzy.vladimir@gmail.com","password":"diagnostic_wrong"}'
```

**Ожидание:** теперь должен прийти **401 `Invalid username or password`**, а НЕ 500. Это подтвердит что БД живая. Пароль ещё не знаем — следующий шаг.

---

## 🔧 STEP 5 — Сбросить пароль (когда БД работает)

Если Владимир не помнит пароль, создаём скрипт-сброс. Скрипт обращается к Turso **напрямую через `@libsql/client`**, чтобы не зависеть от Prisma-билда и работать локально.

### Создать скрипт `scripts/reset-password.ts`

```typescript
/**
 * Reset password for an existing Control Center user.
 *
 * Usage:
 *   npx tsx scripts/reset-password.ts <username>
 *
 * Пишет напрямую в Turso через @libsql/client (минует Prisma).
 * Читает TURSO_DATABASE_URL + TURSO_AUTH_TOKEN из .env.
 * Новый пароль генерируется случайно и печатается в stdout ОДИН раз.
 */
import { createClient } from "@libsql/client";
import { randomBytes, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// Простой .env loader чтобы не тянуть dotenv
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env not found");
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Та же функция что в src/lib/auth.ts — SHA-256 + salt
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

function generatePassword(): string {
  // 16 символов, alpha+digits+спецсимволы (без кавычек и слешей)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function main() {
  loadEnv();
  const username = (process.argv[2] || "").toLowerCase().trim();
  if (!username) {
    console.error("Usage: npx tsx scripts/reset-password.ts <username>");
    process.exit(1);
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set");

  const db = createClient({ url, authToken });

  // Проверяем существует ли юзер
  const existing = await db.execute({
    sql: "SELECT id, username FROM User WHERE username = ?",
    args: [username],
  });
  if (existing.rows.length === 0) {
    console.error(`User '${username}' not found. Available users:`);
    const all = await db.execute("SELECT username FROM User");
    for (const r of all.rows) console.error(`  - ${r.username}`);
    process.exit(2);
  }

  const newPassword = generatePassword();
  const newHash = hashPassword(newPassword);

  await db.execute({
    sql: "UPDATE User SET passwordHash = ? WHERE username = ?",
    args: [newHash, username],
  });

  // Единственный раз печатаем пароль
  console.log("\n========== PASSWORD RESET ==========");
  console.log(`User:     ${username}`);
  console.log(`Password: ${newPassword}`);
  console.log("====================================");
  console.log("\n⚠️  Сохрани пароль сейчас — больше не покажется.");
  console.log("⚠️  Пароль применён и к проду (Turso cloud), и к локалке (через тот же Turso).");
}

main().catch((e) => {
  console.error("❌ Reset failed:", e);
  process.exit(1);
});
```

### Запустить

```bash
# tsx должен быть в devDeps; если нет — поставить
npm ls tsx || npm i -D tsx

npx tsx scripts/reset-password.ts kuzy.vladimir@gmail.com
```

Скрипт выведет новый пароль **одним блоком в stdout**. Скопируй и передай Владимиру в финальном сообщении в чате Claude Code.

### Если юзера НЕТ (ветка (c) или вариант "создать заново")

Создай отдельный скрипт `scripts/create-admin.ts` с идентичной структурой, но делающий `INSERT INTO User(id, username, passwordHash, displayName, createdAt) VALUES (?, ?, ?, ?, datetime('now'))`. Для `id` используй `randomBytes(12).toString("hex")` или импортируй cuid (если cuid лежит в deps). Username подтверди у Владимира прежде чем создавать.

---

## ✅ STEP 6 — Финальная проверка end-to-end

1. **Живой curl с новым паролем** (замени `<NEW_PASSWORD>`):

   ```bash
   curl -i -X POST https://salutemsolutions.info/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"kuzy.vladimir@gmail.com","password":"<NEW_PASSWORD>"}'
   ```

   Ожидание: `HTTP/2 200`, тело `{"ok":true,"user":{"username":"kuzy.vladimir@gmail.com",...}}`, заголовок `set-cookie: sscc-session=...`.

2. **Живой curl с НЕверным паролем** для контроля:

   ```bash
   curl -i -X POST https://salutemsolutions.info/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"kuzy.vladimir@gmail.com","password":"wrong_on_purpose"}'
   ```

   Ожидание: `HTTP/2 401`, `{"error":"Invalid username or password"}` — НЕ 500.

3. Попроси Владимира в финальном сообщении зайти на https://salutemsolutions.info/login и залогиниться с новым паролем.

---

## 📝 STEP 7 — Коммит

Коммить **только** то что мы реально изменили в коде:

- `scripts/reset-password.ts` (если создан)
- `scripts/create-admin.ts` (если создан)

**НЕ коммить:**
- `.env` (должен быть в `.gitignore` — проверь)
- `/tmp/vercel.production.env` (мы уже удалили)
- Никаких файлов с ключами

Проверь `git status` перед коммитом. Если там `.env` или `/tmp/*` — останови, разберись почему в `.gitignore` что-то пропущено.

```bash
git status
git diff --stat
git add scripts/reset-password.ts  # и/или create-admin.ts
git commit -m "feat(scripts): add reset-password helper for Control Center users"
git push origin main
```

Если менялся `.env` на Vercel — никакого коммита не нужно, Vercel env живёт отдельно от репо.

---

## 📋 ФИНАЛЬНЫЙ ОТЧЁТ ВЛАДИМИРУ

В последнем сообщении дай короткий отчёт:

1. **Что было сломано** (1-2 строки, человеческим языком) — например: "На Vercel был просрочен TURSO_AUTH_TOKEN, БД не отвечала. Заодно сбросили пароль."
2. **Новый пароль** (если делали reset) — один блок, крупно.
3. **Что делать сейчас** — "Зайди на https://salutemsolutions.info/login с email `kuzy.vladimir@gmail.com` и паролем `<NEW>`. После входа — в Settings смени пароль на свой (если у нас есть такая страница; если нет — оставь как есть, он уже случайный и крепкий)."
4. **Что изменилось в репо** — список коммитов.
5. **Что остаётся открытым (если что-то)** — например: "Фронтенд всё ещё показывает 'Network error' вместо реального сообщения с бэка. Не критично, но стоит позже поправить в `src/app/login/page.tsx`: при `response.ok === false` показывать `data.error`, а не generic 'Network error'."

---

## 🔗 Связанные документы

- `src/app/api/auth/login/route.ts` — код логина
- `src/app/api/auth/register/route.ts` — код регистрации (закрыта после первого юзера)
- `src/lib/auth.ts` — `hashPassword`, `verifyPassword`, session tokens
- `src/lib/prisma.ts` — выбор между Turso и локальным SQLite
- `prisma/schema.prisma` — модель `User`
- `.vercel/project.json` — project + org ID на Vercel
- `docs/wiki/auth-system.md` — общий обзор системы авторизации (см. в wiki)
- `docs/wiki/deploy-to-vercel-plan.md` — исторический план деплоя (Postgres устарел, фактически Turso)

---

**Версия:** v1.0
**Создан:** 2026-04-18 (Claude chat session)
**После выполнения:** обнови `docs/wiki/auth-system.md` разделом "История" с датой и что именно было починено.
