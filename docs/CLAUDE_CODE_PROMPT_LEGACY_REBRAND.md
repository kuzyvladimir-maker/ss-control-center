# 🎨 Claude Code Prompt — Rebrand Legacy Components to Salutem Design System

**Scope:** 3 файла на синей Tailwind-палитре → перевести на Salutem Design System
**Дата:** 2026-05-03
**Зависимости:** Phase 0 audit (`docs/MOBILE_ADAPTATION_AUDIT.md` § 4.11, § 4.12)
**Связь с Phase 1:** независимая задача, можно делать ДО, ПОСЛЕ или ПАРАЛЛЕЛЬНО Phase 1
**Оценка:** ~30 минут работы Claude Code, ~150 строк изменений

---

## 0. TL;DR

В трёх местах проекта остался **легаси-код на стандартной Tailwind палитре** (синие/серые цвета `bg-blue-600`, `text-gray-700`, `border-slate-200`), не переведённый на **Salutem Design System** при общей миграции UI.

Это создаёт **визуальный разрыв**: пользователь логинится через синий SaaS-стиль экран, а после логина попадает в зелёно-кремовое Salutem-приложение. Для собственного internal tool — это непрофессионально и ломает brand consistency.

**Файлы для ребрендинга:**
1. `src/app/login/page.tsx` — экран логина
2. `src/app/invite/[token]/page.tsx` — экран принятия приглашения
3. `src/components/cs/StoreTabs.tsx` — табы переключения магазинов в Customer Service модуле

**Цель:** заменить все Tailwind palette классы на Salutem-токены, сохранив **всю функциональность** (форма, валидация, async-логика, состояния error/loading).

---

## 1. Stack & Context

- **Salutem Design System v1.0** — все токены в `src/app/globals.css` через `@theme inline`
- **Используются shadcn-маппинги:** `--primary` = `--green`, `--secondary` = `--surface-tint`, и т.д.
- В Tailwind v4 проекта доступны utility-классы: `bg-green`, `text-ink`, `bg-surface`, etc. — они автоматически биндятся к CSS-токенам через `@theme inline`

---

## 2. Salutem Token Cheatsheet (что использовать вместо чего)

### Цвета (mapping)

| Tailwind palette (запрещено) | Salutem token (использовать) | Назначение |
|---|---|---|
| `bg-white` | `bg-surface` | Карточки, модалки |
| `bg-gray-50`, `bg-slate-50` | `bg-surface-tint` | Лёгкий tinted фон |
| `bg-gray-100`, `bg-slate-100` | `bg-bg-elev` | Чуть более выраженный фон |
| `bg-blue-50`, `from-blue-50` | `bg-green-soft` | Inviting accent фон |
| `bg-blue-500`, `bg-blue-600` | `bg-green` | Primary brand button |
| `bg-blue-700` (hover) | `bg-green-deep` (hover) | Primary button hover |
| `text-gray-900`, `text-slate-900` | `text-ink` | Основной текст |
| `text-gray-700`, `text-slate-700` | `text-ink-2` | Вторичный текст |
| `text-gray-500`, `text-slate-500` | `text-ink-3` | Подписи, плейсхолдеры |
| `text-gray-400`, `text-slate-400` | `text-ink-4` | Отключённый текст |
| `text-gray-300`, `text-slate-300` | `text-ink-4` (или `opacity-40`) | Disabled state |
| `text-blue-500`, `text-blue-600` | `text-green` | Brand color text |
| `text-blue-700`, `text-blue-800` | `text-green-ink` или `text-green-deep` | Тёмный brand text |
| `text-white` | `text-green-cream` | Текст на зелёном фоне (НЕ pure white!) |
| `border-gray-200`, `border-slate-200` | `border-rule` | Лёгкие разделители |
| `border-gray-300`, `border-slate-300` | `border-rule-strong` или `border-rule` | Границы инпутов |
| `border-blue-500`, `border-blue-600` | `border-green` | Активные/focus границы |
| `bg-red-50` | `bg-danger-tint` | Error background |
| `text-red-600`, `text-red-700` | `text-danger` | Error text |
| `focus:ring-blue-500` | `focus:ring-green-mid` или `focus:ring-green` | Focus rings |
| `focus:border-blue-500` | `focus:border-green-mid` | Focus borders |

### Дополнительные принципы

- **`bg-green-cream` (#F0E8D0)** используется ТОЛЬКО как text color поверх `bg-green` фона. Это правило Salutem DS: `text-white` неправильно — на зелёном Salutem использует кремовый, не белый.
- **`text-ink` (#15201B)** — почти-чёрный с зеленоватым подтоном. НЕ использовать pure `text-black`.
- Для shadow используем `shadow-sm`, `shadow-md` без изменений (нейтральные тени работают).
- **Background gradient** в Login/Invite (`bg-gradient-to-br from-blue-50 to-indigo-100`) — заменить на однотонный `bg-bg` (= #F4F3EF) или `bg-gradient-to-br from-bg to-bg-elev`. Полностью убрать blue/indigo.

---

## 3. ⚠️ Что НЕ трогать

1. **Бизнес-логика** — `handleSubmit`, `submit`, fetch-вызовы к `/api/auth/login` и `/api/auth/invite/[token]`, валидация (`password.length < 8`, etc.), редиректы (`router.push`, `router.refresh`), state management (`useState`, `useEffect`).
2. **Структуру JSX** — оставить ту же иерархию div/form/input. Менять ТОЛЬКО `className`.
3. **Атрибуты форм** — `autoComplete`, `required`, `autoFocus`, `type="email"`, `id`, `htmlFor` — всё на месте.
4. **Текстовое содержимое** — "SS Control Center", "Salutem Solutions", "Sign In", "Min 8 characters", "Access is invite-only..." — не менять.
5. **Layout файлы** — `src/app/login/layout.tsx` остаётся как есть (`return children`). Его трогать не нужно.
6. **`STANDALONE_PREFIXES` в AppShell** — login/invite по-прежнему обходят AppShell (это правильно).

---

## 4. Файл 1: `src/app/login/page.tsx`

### Конкретные замены

**Outer wrapper (line ~52):**
```tsx
// Before:
<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">

// After:
<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-bg to-bg-elev">
```

**Card (line ~53):**
```tsx
// Before:
<div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">

// After:
<div className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-lg border border-rule">
```
*(добавили `border border-rule` — на cream-фоне белая карточка без границы выглядит размыто)*

**Title (line ~55):**
```tsx
// Before:
<h1 className="text-2xl font-bold text-gray-900">SS Control Center</h1>

// After:
<h1 className="text-2xl font-bold text-ink">SS Control Center</h1>
```

**Subtitle (line ~56):**
```tsx
// Before:
<p className="mt-1 text-sm text-gray-500">Salutem Solutions</p>

// After:
<p className="mt-1 text-sm text-ink-3">Salutem Solutions</p>
```

**Labels — username + password (lines ~63, ~83):**
```tsx
// Before (применяется к двум labels):
className="block text-sm font-medium text-gray-700"

// After:
className="block text-sm font-medium text-ink-2"
```

**Input — username (line ~73):**
```tsx
// Before:
className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"

// After:
className="mt-1 block w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink shadow-sm placeholder:text-ink-4 focus:border-green-mid focus:outline-none focus:ring-1 focus:ring-green-mid"
```
*(добавлен `bg-surface` явно, `text-ink` для введённого текста, `placeholder:text-ink-4` для светлого плейсхолдера)*

**Input — password (line ~93):**
```tsx
// Before:
className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"

// After (тот же класс что у username):
className="mt-1 block w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink shadow-sm placeholder:text-ink-4 focus:border-green-mid focus:outline-none focus:ring-1 focus:ring-green-mid"
```

**Error message (line ~99):**
```tsx
// Before:
{error && <p className="text-sm text-red-600">{error}</p>}

// After:
{error && <p className="text-sm text-danger">{error}</p>}
```

**Submit button (line ~101):**
```tsx
// Before:
className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"

// After:
className="w-full rounded-lg bg-green px-4 py-2 text-sm font-medium text-green-cream hover:bg-green-deep focus:outline-none focus:ring-2 focus:ring-green-mid focus:ring-offset-2 focus:ring-offset-surface disabled:opacity-50"
```
*(`text-white` → `text-green-cream` это ВАЖНО — на зелёном Salutem использует кремовый, не белый. Это базовое правило design system. Также добавили `focus:ring-offset-surface` чтобы offset был на правильном фоне)*

**Footer text (line ~113):**
```tsx
// Before:
<p className="mt-6 text-center text-xs text-gray-400">

// After:
<p className="mt-6 text-center text-xs text-ink-4">
```

---

## 5. Файл 2: `src/app/invite/[token]/page.tsx`

Структура очень похожа на Login. Все те же замены, плюс несколько уникальных мест.

### Outer wrapper (line ~80):
```tsx
// Before:
<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">

// After:
<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-bg to-bg-elev">
```

### Card (line ~81):
```tsx
// Before:
<div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">

// After:
<div className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-lg border border-rule">
```

### Title (line ~83):
```tsx
// Before:
<h1 className="text-2xl font-bold text-gray-900">SS Control Center</h1>

// After:
<h1 className="text-2xl font-bold text-ink">SS Control Center</h1>
```

### Subtitle (line ~84):
```tsx
// Before:
<p className="mt-1 text-sm text-gray-500">Accept invitation</p>

// After:
<p className="mt-1 text-sm text-ink-3">Accept invitation</p>
```

### Loading text (line ~88):
```tsx
// Before:
<p className="text-center text-sm text-gray-500">Loading…</p>

// After:
<p className="text-center text-sm text-ink-3">Loading…</p>
```

### Error block — invalid invite (line ~92):
```tsx
// Before:
<div className="rounded-md bg-red-50 px-3 py-3 text-sm text-red-700">

// After:
<div className="rounded-md bg-danger-tint px-3 py-3 text-sm text-danger">
```

### Info block — "You were invited as..." (line ~99):
```tsx
// Before:
<div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-800">

// After:
<div className="rounded-md bg-green-soft px-3 py-2 text-xs text-green-ink">
```

### "Display name (optional)" — span внутри label (line ~106):
```tsx
// Before:
Display name <span className="text-gray-400">(optional)</span>

// After:
Display name <span className="text-ink-4">(optional)</span>
```

### Все 3 labels (Display name / Password / Confirm password):
```tsx
// Before (повторяется 3 раза):
className="block text-sm font-medium text-gray-700"

// After:
className="block text-sm font-medium text-ink-2"
```

### Все 3 inputs (displayName / password / confirm):
```tsx
// Before (повторяется 3 раза):
className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"

// After:
className="mt-1 block w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink shadow-sm placeholder:text-ink-4 focus:border-green-mid focus:outline-none focus:ring-1 focus:ring-green-mid"
```

### Error message (line ~166):
```tsx
// Before:
{error && <p className="text-sm text-red-600">{error}</p>}

// After:
{error && <p className="text-sm text-danger">{error}</p>}
```

### Submit button (line ~168):
```tsx
// Before:
className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"

// After:
className="w-full rounded-lg bg-green px-4 py-2 text-sm font-medium text-green-cream hover:bg-green-deep focus:outline-none focus:ring-2 focus:ring-green-mid focus:ring-offset-2 focus:ring-offset-surface disabled:opacity-50"
```

---

## 6. Файл 3: `src/components/cs/StoreTabs.tsx`

Это переключалка табов для разных магазинов в Customer Service модуле. Использует синюю палитру для активного таба.

### Container border (line ~28):
```tsx
// Before:
<div className="flex gap-1 overflow-x-auto border-b border-slate-200 pb-px">

// After:
<div className="flex gap-1 overflow-x-auto border-b border-rule pb-px">
```

### Button — active/disabled/default states (lines ~38-46):

```tsx
// Before:
className={`relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors rounded-t-md ${
  isActive
    ? "text-blue-600 bg-blue-50/50 border-b-2 border-blue-600"
    : isDisabled
      ? "text-slate-300 cursor-not-allowed"
      : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
}`}
```

```tsx
// After:
className={`relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors rounded-t-md ${
  isActive
    ? "text-green-ink bg-green-soft border-b-2 border-green"
    : isDisabled
      ? "text-ink-4 cursor-not-allowed"
      : "text-ink-3 hover:text-ink hover:bg-bg-elev"
}`}
```

### "(not set)" span (line ~62):
```tsx
// Before:
<span className="text-[9px] text-slate-300 ml-0.5">

// After:
<span className="text-[9px] text-ink-4 ml-0.5">
```

### Error dot (line ~67):
```tsx
// Before:
<span className="h-1.5 w-1.5 rounded-full bg-red-400" />

// After:
<span className="h-1.5 w-1.5 rounded-full bg-danger" />
```

---

## 7. Testing checklist

После всех изменений проверить:

### Login page (`/login`)
- [ ] Открыть в режиме инкогнито (чтобы не быть залогиненным).
- [ ] Фон страницы — светлый кремовый (НЕ голубой, НЕ синий).
- [ ] Карточка логина — белая (`bg-surface`) с тонкой границей.
- [ ] Кнопка "Sign In" — **тёмно-зелёная** (`#1F4D3F`), текст на ней — **кремовый** (`#F0E8D0`), НЕ белый.
- [ ] При клике на input поля — фокус-кольцо **зелёное** (`green-mid`), НЕ синее.
- [ ] Ввести неверный пароль → error message **тёмно-красный** (`--danger: #9B2C2C`), не яркий.
- [ ] При hover на кнопке Sign In цвет становится темнее (`green-deep`).
- [ ] При successful login → редирект на `/` работает как раньше.

### Invite page (`/invite/[token]`)
- [ ] Открыть с **невалидным** токеном (например `/invite/test`) → красный блок "Invalid invite" в **Salutem-стиле** (`bg-danger-tint text-danger`).
- [ ] Открыть с **валидным** invite токеном (если есть в БД) → зелёный info-блок "You were invited as..." (`bg-green-soft text-green-ink`).
- [ ] Все 3 input'а (Display name, Password, Confirm) — фокус-кольцо зелёное.
- [ ] Кнопка "Create account & sign in" — зелёная с кремовым текстом.
- [ ] Validation error (passwords don't match) — `text-danger`.

### CS StoreTabs (`/customer-hub` или где он используется)
- [ ] Активный таб — **зелёный текст + светло-зелёный фон + зелёная нижняя линия**.
- [ ] Hover на неактивном табе — текст темнеет (`text-ink-3 → text-ink`), фон `bg-bg-elev`.
- [ ] Disabled таб (если есть `comingSoon` магазин) — `text-ink-4`, не кликабельный.
- [ ] "(not set)" подпись — серая (`text-ink-4`).
- [ ] Error dot (если есть error на сторе) — тёмно-красный (`bg-danger`).

### Cross-check
- [ ] **Запустить grep по проекту:** в этих 3 файлах НЕ должно остаться ни одного вхождения:
  - `bg-blue-`, `text-blue-`, `border-blue-`, `from-blue-`, `to-indigo-`, `focus:ring-blue-`, `focus:border-blue-`
  - `bg-gray-`, `text-gray-`, `border-gray-`
  - `text-slate-`, `border-slate-`, `bg-slate-`
  - `bg-red-` (заменено на `bg-danger-tint`), `text-red-` (заменено на `text-danger`)
  - `text-white` (заменено на `text-green-cream` где это текст на зелёном фоне)

  Команда для проверки:
  ```bash
  grep -nE "(bg-blue-|text-blue-|border-blue-|from-blue-|to-indigo-|bg-gray-|text-gray-|border-gray-|text-slate-|border-slate-|bg-slate-)" \
    src/app/login/page.tsx \
    src/app/invite/\[token\]/page.tsx \
    src/components/cs/StoreTabs.tsx
  ```
  Если grep вернёт что-либо — это упущенный класс, поправить.

### Functional regression
- [ ] Login flow работает: ввести правильный логин/пароль → редирект на `/`.
- [ ] Login flow с ошибкой: ввести неверный пароль → отображается error.
- [ ] Invite flow работает: открыть с валидным токеном → создать пароль → редирект на `/`.
- [ ] StoreTabs корректно переключает stores в Customer Hub.

---

## 8. После завершения

### 8.1. Wiki update

Создать **новый** файл `docs/wiki/legacy-rebrand-2026-05.md`:

```md
# Legacy Rebrand — Login / Invite / StoreTabs (2026-05)

## Контекст
В ходе Phase 0 mobile audit (2026-05-03) обнаружено, что 3 файла используют стандартную Tailwind-палитру (синие/серые цвета) вместо Salutem Design System. Это легаси от до-Salutem периода разработки.

## Что было исправлено
- `src/app/login/page.tsx` — переведён на Salutem
- `src/app/invite/[token]/page.tsx` — переведён на Salutem
- `src/components/cs/StoreTabs.tsx` — переведён на Salutem

## Принцип
Все Tailwind palette классы (`bg-blue-*`, `text-gray-*`, `border-slate-*`, etc.) заменены на Salutem токены через стандартный mapping (см. `docs/CLAUDE_CODE_PROMPT_LEGACY_REBRAND.md` § 2).

## Ключевые правила Salutem (для будущих компонентов)
- Текст на зелёном фоне = `text-green-cream` (НЕ `text-white`)
- Основной текст = `text-ink` (НЕ `text-black` или `text-gray-900`)
- Границы инпутов = `border-rule-strong`
- Focus = `focus:ring-green-mid`
- Error = `text-danger` + `bg-danger-tint`
- Brand button = `bg-green hover:bg-green-deep text-green-cream`

## 🔗 Связи
← Salutem Design System v1.0 (`/design/DESIGN_TOKENS.md`)
← Mobile Adaptation audit (Phase 0, обнаружил баги)
→ Auth System (login UI)
→ Customer Hub (StoreTabs)
```

### 8.2. Обновить index.md

В `docs/wiki/index.md` в секцию "## Решения и паттерны" добавить:
```md
- [Legacy Rebrand 2026-05](legacy-rebrand-2026-05.md) — миграция Login/Invite/StoreTabs на Salutem Design System
```

### 8.3. Обновить CONNECTIONS.md

Добавить новую секцию:
```md
### [Legacy Rebrand 2026-05](legacy-rebrand-2026-05.md)
← [Mobile Adaptation](mobile-adaptation.md) (баг обнаружен в Phase 0 audit)
→ [Auth System](auth-system.md), [Customer Hub](customer-hub.md)
⊂ Salutem Design System
```

### 8.4. Git commit message

```
fix(ui): rebrand Login/Invite/StoreTabs to Salutem Design System

Three legacy files were using default Tailwind palette (bg-blue-*,
text-gray-*, border-slate-*) instead of Salutem tokens. Created visual
discontinuity: blue SaaS-style login → green Salutem app after sign-in.

Files migrated:
- src/app/login/page.tsx
- src/app/invite/[token]/page.tsx
- src/components/cs/StoreTabs.tsx

Mapping: bg-blue-600 → bg-green, text-white → text-green-cream,
text-gray-* → text-ink-*, border-gray-* → border-rule, etc.

No functional changes — only className replacements.

Refs: docs/MOBILE_ADAPTATION_AUDIT.md (§ 4.11, § 4.12)
      docs/wiki/legacy-rebrand-2026-05.md (новая статья)
```

---

## 9. Связь с Phase 1 (mobile)

**Эта задача независима от Phase 1.** Можно выполнять:
- **ДО** Phase 1 — рекомендуется, потому что login — первый экран который видит пользователь.
- **ПОСЛЕ** Phase 1 — тоже OK, не блокирует ничего.
- **ПАРАЛЛЕЛЬНО** Phase 1 — НЕ рекомендуется (могут быть конфликты при merge, особенно если оба меняют какие-то общие компоненты — хотя в данном случае не пересекаются).

При выполнении после Phase 1 — внимание: Login и Invite используют `STANDALONE_PREFIXES` в AppShell (получают свой layout без sidebar). Это правильно и Phase 1 эту логику сохранил.

---

**Конец промпта.** ~30 минут работы Claude Code, после чего проверка через `/login` и `/invite/[token]`.
