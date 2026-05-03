# Claude Code — Применить Salutem Design System к Next.js проекту

## Задача

Перенести визуальную систему из HTML mockup'ов в рабочий Next.js 14 проект. Сейчас mockup'ы — источник правды для дизайна, но в коде приложения дизайн-система ещё не настроена.

## Контекст

Стек проекта: **Next.js 14 (App Router) + TypeScript + Tailwind CSS + shadcn/ui + SQLite/Prisma**.

7 готовых HTML mockup'ов лежат в `/design/`:

- `design/DESIGN_TOKENS.md` — **single source of truth** для палитры, типографики, радиусов
- `design/dashboard_salutem.html`
- `design/account_health_salutem.html`
- `design/shipping_labels_salutem.html`
- `design/customer_hub_salutem_v2.html`
- `design/frozen_analytics_salutem.html`
- `design/adjustments_salutem.html`
- `design/settings_salutem.html`

Каждый mockup — автономный HTML со встроенным CSS (~1100 строк), открывается двойным кликом. CSS variables и разметка во всех 7 файлах одинаковые (sidebar, topbar, карточки, чипы, аватары магазинов и т.д.).

Описание системы: `docs/wiki/design/index.md`.

---

## Что сделать

### Шаг 1 — Прочитать источники правды

Перед любым кодом прочитай:

1. `design/DESIGN_TOKENS.md` — все CSS-переменные, шрифты, радиусы
2. `docs/wiki/design/index.md` — описание системы и список общих компонентов
3. Любой из mockup'ов целиком (например, `design/dashboard_salutem.html`) — чтобы увидеть как всё собирается вместе

### Шаг 2 — Настроить фундамент дизайн-системы

**2.1. `tailwind.config.ts`** — перенеси палитру Salutem в `theme.extend.colors`. Все CSS-переменные из `DESIGN_TOKENS.md` (`--bg`, `--ink`, `--green`, `--green-cream`, `--silver`, `--frozen`, `--dry`, `--warn`, `--danger` и т.д.) должны стать Tailwind-классами: `bg-bg`, `text-ink`, `bg-green`, `text-green-cream`, `bg-frozen-tint text-frozen` и т.д.

**2.2. `app/layout.tsx`** — подключи шрифты через `next/font/google`:
- Inter Tight (weights 400, 500, 600, 700) — как `--font-sans`
- JetBrains Mono (weights 400, 500) — как `--font-mono`

**2.3. `app/globals.css`** — перенеси CSS-переменные из mockup'ов в `:root`, настрой `body` (font-size 13.5px, letter-spacing -0.005em, bg-bg text-ink, `-webkit-font-smoothing: antialiased`), добавь `@keyframes pulse` для живых индикаторов.

**2.4. shadcn/ui компоненты** — перенастрой существующие `Button`, `Card`, `Table`, `Tabs`, `Dialog`, `Input`, `Badge` под Salutem токены. **Никакого дефолтного shadcn look** — primary button должен быть `bg-green text-green-cream`, карточки с `rounded-[14px] border-rule bg-surface`, и т.д.

### Шаг 3 — Создать общие компоненты

Положи в `components/layout/` и `components/ui/`:

- `Sidebar` — 236px, brand block + workspace switcher + nav (Operations / Phase 2) + Settings внизу + helper-card. Активный пункт определяется по текущему роуту (`usePathname`). Nav items: Dashboard, Account health, Shipping labels, Customer hub, Frozen analytics, Adjustments, (disabled) Product listings, Sales analytics, Settings.
- `Topbar` — 56px, breadcrumb + search (⌘K) + live-pill + notifications + user-chip
- `StoreAvatar` — принимает `variant: 'salutem' | 'amzcom' | 'sirius' | 'walmart' | 'retail' | 'personal'` и `size: 'sm' | 'md' | 'lg'`
- `TypeTag` — `Frozen` / `Dry` чип с цветным дотом
- `RiskPill` — `low` / `medium` / `high` / `critical`
- `SyncChip` — "Last sync Xm ago" с пульсирующим дотом
- `KpiCard` — label + иконка + большое число + chips/progress/sparkline
- `HeroGreenCard` — зелёная карточка с cream-текстом и декоративными кругами через `::before` / `::after`

**Важно:** компоненты не должны хардкодить бизнес-данные. Все данные — через пропсы.

### Шаг 4 — Собрать главный layout

`app/(dashboard)/layout.tsx` — обёртка для всех защищённых страниц с Sidebar + Topbar. Контент родитель: `max-width: 1500px, padding: 28px 32px 40px`.

### Шаг 5 — Реализовать страницы (по одной, в таком порядке)

Каждая страница = route в `app/`. Визуальная структура — **точно** как в соответствующем mockup'е:

1. `app/(dashboard)/page.tsx` → `design/dashboard_salutem.html`
2. `app/(dashboard)/shipping-labels/page.tsx` → `design/shipping_labels_salutem.html`
3. `app/(dashboard)/customer-hub/page.tsx` → `design/customer_hub_salutem_v2.html`
4. `app/(dashboard)/adjustments/page.tsx` → `design/adjustments_salutem.html`
5. `app/(dashboard)/account-health/page.tsx` → `design/account_health_salutem.html`
6. `app/(dashboard)/frozen-analytics/page.tsx` → `design/frozen_analytics_salutem.html`
7. `app/(dashboard)/settings/page.tsx` → `design/settings_salutem.html`

Начни с Шагов 1–4 и первой страницы (Dashboard). Остановись, покажи результат, дождись подтверждения — дальше пойдём итеративно.

---

## Правила соответствия дизайну (критично)

- ❌ Никогда не использовать чёрный текст (`#000`). Только `--ink: #15201B` или один из `--ink-2/3/4`
- ❌ Никогда не использовать белый текст на зелёном фоне. Только `--green-cream: #F0E8D0`
- ❌ Никогда не использовать красный для отрицательных финансовых чисел. Используй `--ink-2`. Красный (`--danger`) — только для реальных ошибок
- ❌ Никаких множественных теней, никакого blur эффекта, никакого gradient-фона на карточках
- ✅ Все числа — `font-variant-numeric: tabular-nums`
- ✅ Моно-шрифт (JetBrains Mono) только для: IDs, timestamps, SKU, суммы денег, коды, API endpoints, label-текстов секций uppercase
- ✅ Базовый размер шрифта — 13.5px
- ✅ Радиусы: 6px (пиллы, чипы), 10px (инпуты), 14px (основные карточки)
- ✅ Сайдбар — 236px, топбар — 56px

---

## Что пока НЕ делать

- Не подключай реальные API (Veeqo, SP-API, Gmail) — пока все данные mock'овые, хардкод в страницах
- Не трогай Prisma схему
- Не пиши бизнес-логику (Decision Engine, фильтрация, покупка labels) — только UI каркас с mock-данными
- Не меняй существующую структуру проекта без согласования

---

## Вопросы ко мне, если что-то непонятно

Перед кодингом, если есть сомнения:
- "В проекте уже настроен Tailwind или начать с нуля?"
- "shadcn/ui уже инициализирован?"
- "Есть ли существующий `app/layout.tsx` или создаём?"
- "Использовать `(dashboard)` route group или плоскую структуру?"

Спроси и дождись ответа до начала работы.
