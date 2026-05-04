# 📱 Mobile Adaptation Audit — SS Control Center

**Дата:** 2026-05-03
**Версия:** 1.0
**Статус:** Аудит завершён, готов к написанию промпта на адаптацию
**Аудитор:** Claude (через Claude Desktop + Filesystem MCP)

---

## 0. TL;DR

Текущая версия SS Control Center **полностью desktop-only на уровне App Shell**, но отдельные страницы внутри уже mobile-ready (в частности **Procurement — идеально**). На телефоне:
- Sidebar 236px съедает 60% экрана 380px-устройства, основной контент превращается в 144px-полоску.
- Таблицы на Dashboard / Customer Hub / Adjustments / Shipping Labels спроектированы под 800–1400px.
- Header с поиском, юзер-чипом, нотификациями плотно набит — переполняется.
- Тулбары PageHead с 3–6 кнопками ломают layout.

**Главный вывод:** фундамент в порядке. Tailwind v4, shadcn/ui (включая Sheet для drawer), Salutem Design System — всё на месте. Адаптация — **точечная работа**, не редизайн.

**Оценка трудозатрат:**
- Phase 1 (Procurement — в основном App Shell + видные полировки): 2–4 часа Claude Code.
- Phase 2 (остальные страницы — mobile-cards для таблиц): 1 день.
- Phase 3 (тестирование + фиксы): 0.5 дня.

---

## 1. Стек и фундамент

### 1.1. Что уже есть
- **Next.js 16.2.2** (App Router) + **React 19.2.4**
- **Tailwind CSS v4** через `@tailwindcss/postcss` и `@theme inline` в `globals.css`. Брейкпоинты по умолчанию: `sm=640`, `md=768`, `lg=1024`, `xl=1280`, `2xl=1536`.
- **shadcn/ui** компоненты в `src/components/ui/` (Dialog, Sheet, Tabs, Card, Table, и др.). Доступен `Sheet` — это **критично**, потому что Sheet — стандартный паттерн для drawer/sidebar на мобиле.
- **Salutem Design System v1.0** в `src/app/globals.css` — все CSS-переменные, цвета, типографика, радиусы.
- **Custom kit** в `src/components/kit/` (Btn, KpiCard, PageHead, Panel, FilterTabs, StoreAvatar, etc.) — общие компоненты.
- Шрифты: Inter Tight + JetBrains Mono через `next/font/google`.

### 1.2. Что отсутствует и нужно добавить
- ❌ **`useMediaQuery` хук** или `useIsMobile` — для условного рендеринга в TS.
- ❌ **MobileNav / Drawer** компонент — обёртка над shadcn `Sheet` для бокового меню.
- ❌ **MobileHeader** или мобильная версия `Header.tsx` (с гамбургером).
- ❌ **MobileTable** или паттерн "Table → Cards" — карточный вид строк таблиц.
- ❌ **OverflowActions** или `MobileActionMenu` — выпадайка для действий, которые не помещаются в шапку.
- ❌ Адаптивный CSS-токен `--content-padding-mobile` или брейкпоинт-зависимое значение.

---

## 2. Layout-фундамент: проблемы

### 2.1. `src/app/layout.tsx`
```tsx
<body className="flex h-screen overflow-hidden bg-bg text-ink">
  <AppShell>{children}</AppShell>
</body>
```
**Проблема:** `flex h-screen overflow-hidden` на body заставляет sidebar и main быть в одной горизонтальной строке. На мобиле sidebar НЕ скрывается — он просто стоит рядом с main, занимая 236px.

**Решение:** оставить `h-screen` и `flex`, но добавить логику рендеринга sidebar — он должен превращаться в overlay/drawer на мобиле.

### 2.2. `src/components/layout/AppShell.tsx`
```tsx
<TooltipProvider>
  <Sidebar />
  <div className="flex flex-1 flex-col overflow-hidden bg-bg">
    <Header />
    <main className="flex-1 overflow-auto" style={{ padding: "var(--content-padding)" }}>
      <div className="mx-auto" style={{ maxWidth: "var(--content-max)" }}>
        {children}
      </div>
    </main>
  </div>
</TooltipProvider>
```

**Проблемы:**
1. **Sidebar всегда виден.** Нет условия `<Sidebar className="hidden md:flex" />` или toggle-state.
2. **`var(--content-padding)` = `28px 32px 40px`** — слишком много для мобилы. Нужно `16px 16px 24px` на мобиле.
3. **Нет хранения state открытия мобильного drawer** (`isMobileNavOpen`).

**Решение:**
- Скрыть `<Sidebar />` ниже `md:` (`hidden md:flex`), вместо него рендерить `<MobileNav />` с гамбургером.
- Добавить React state `isMobileNavOpen` через context (или просто `useState`), пробрасывать в `Header` и `MobileNav`.
- Добавить адаптивный padding: либо через Tailwind классы (`p-4 md:p-7 md:pt-7 md:pb-10`), либо через CSS-переменную с `@media`.

### 2.3. `src/components/layout/Sidebar.tsx`
```tsx
<aside
  className="flex h-screen flex-col border-r border-rule bg-surface"
  style={{ width: "var(--sidebar-width)" }}  // 236px
>
```
**Проблема:** Жёстко зашитая ширина 236px без responsive override.

**Решение:**
1. Сделать **2 версии рендеринга**: desktop (как сейчас, `hidden md:flex`) и mobile (внутри shadcn `Sheet`, т.е. в drawer).
2. Вынести содержимое sidebar (nav-секции, brand-блок, helper-card) в **`SidebarContent`** компонент, чтобы переиспользовать в обоих режимах.
3. Финальная структура:
   - `Sidebar.tsx` (desktop, `hidden md:flex`)
   - `MobileNav.tsx` (мобильный wrapper над `Sheet`)
   - `SidebarContent.tsx` (общая начинка)

### 2.4. `src/components/layout/Header.tsx`
Сейчас в шапке:
1. Search bar `max-w-[380px]` — на 380px-экране займёт всю ширину.
2. Spacer `<div className="flex-1" />`
3. Live pill `hidden sm:inline-flex` ✅ (правильно скрывается)
4. Bell button (8x8)
5. User chip с инициалами + (на ≥sm) displayName + admin shield

**Проблемы:**
- Нет места для **гамбургер-кнопки** слева.
- Search-бар занимает всё пространство — на мобиле должен превратиться в icon-button (открывает search-drawer или modal).
- "5 stores live" pill, displayName и `⌘K` хорошо скрываются через `sm:` — это уже работает.

**Решение:**
- Слева — гамбургер `<button onClick={() => setMobileNavOpen(true)} className="md:hidden">`, рендерится только < md.
- Search бар → `hidden md:flex`, плюс рядом `<button className="md:hidden">` с иконкой Search.
- Уменьшить горизонтальный padding шапки: `px-4 md:px-6`.
- Сократить gap между правыми элементами на мобиле.

---

## 3. Страницы и компоненты: проблемы по типам

### 3.1. PageHead (kit/PageHead.tsx) — общий компонент

```tsx
<div className="flex flex-wrap items-end justify-between gap-4 pb-4">
  <div>... title + subtitle ...</div>
  {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
</div>
```

**Текущее поведение:** flex-wrap корректно ломает в 2 ряда, когда не помещается. **Это работает, но плохо выглядит** на узком экране — actions могут переехать вниз и образовать "стену" из 5 кнопок.

**Примеры с большим количеством actions:**
- **Customer Hub:** PeriodFilter + StoreFilter + Sync + WalmartSync + WalmartCaseModal + "Process next" = **6 элементов**.
- **Shipping:** Generate plan + Buy selected + Export = 3.
- **Adjustments:** Refresh = 1 ✅.
- **Dashboard:** Refresh + Generate plan = 2 ✅.

**Решение для PageHead:**
1. Добавить prop `mobileActions?: ReactNode` или `primaryAction?` + `secondaryActions?`.
2. На мобиле:
   - Title всегда на отдельной строке.
   - Под ним subtitle.
   - Под subtitle — горизонтальный скролл-ряд actions ИЛИ "primary + ⋯ overflow" паттерн.
3. **Простейшее решение для MVP:** добавить `<div className="overflow-x-auto no-scrollbar md:overflow-visible">` вокруг actions с `whitespace-nowrap` — actions станут прокручиваемыми влево-вправо на мобиле.

### 3.2. KPI-сетки

Используются на каждой странице. Текущий паттерн:
```tsx
<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
```

**На 380px (default = grid-cols-1):** карточки идут вертикально друг под другом — это **корректно**. ✅

**Мини-проблема:** `KpiCard` имеет `p-4` и значение 30px шрифтом — на узком экране это смотрится прилично, но 4 карточки подряд = ~480px вертикали. Для Dashboard с 4 KPI это нормально, для Customer Hub с 5+ KPI карточек становится длинно.

**Решение:**
- Оставить как есть (grid-cols-1 → 2 → 4) — это правильный responsive паттерн.
- На очень узких экранах (< 360px) можно опционально использовать **горизонтальный скролл-карусель** KPI-карточек: `flex gap-3 overflow-x-auto snap-x snap-mandatory sm:grid sm:grid-cols-2 lg:grid-cols-4`. Это вкусовщина — оставлю на усмотрение Vladimir.

### 3.3. Таблицы — главная боль

Все основные модули используют таблицы с 6–9 колонками:

| Страница | Колонок | Текущая реализация | Минимальная ширина |
|---|---|---|---|
| Dashboard "Awaiting fulfilment" | 6 | shadcn `table` | ~720px |
| Customer Hub Messages | 9 | shadcn `Table` | ~1100px |
| Adjustments | через `AdjustmentsTable` | TBD | ~900px |
| Shipping Labels plan | 8 | CSS Grid с `minmax`-ширинами | **1056px минимум** (фикс. колонки) |

**На мобиле эти таблицы:**
- **shadcn Table** растянется и вызовет горизонтальный скролл всей страницы (или таблицы внутри).
- **Shipping Grid-table** ещё хуже: фиксированные пиксельные колонки `36px + minmax(160px,...) + minmax(180px,...) + 90 + 90 + 140 + minmax(120px,...) + 120` = **минимум 836px** даже при сжатии всех minmax до минимума. Не помещается ни на каком мобильном экране.

**Решение — паттерн "Table on desktop, Cards on mobile":**

Создать общий компонент `MobileCardList` или применять inline-паттерн:
```tsx
{/* Desktop: table */}
<div className="hidden md:block">
  <Table>...</Table>
</div>

{/* Mobile: cards */}
<div className="md:hidden divide-y divide-rule">
  {rows.map(row => (
    <div key={row.id} className="px-4 py-3">
      {/* row 1: главная информация (Order ID + Store badge) */}
      {/* row 2: продукт (truncate, 1 строка) */}
      {/* row 3: chips (Type + Status) + опционально Ship by */}
    </div>
  ))}
</div>
```

**Конкретные карточки для каждой таблицы:**

#### A. Dashboard "Awaiting fulfilment"
```
┌──────────────────────────────────────┐
│ #11324523-12     [SS] Salutem  [Frozen]│
│ Wagyu beef tenderloin 8oz            │
│ Ship by 2:30 PM           [Ready]    │
└──────────────────────────────────────┘
```

#### B. Customer Hub Messages
```
┌──────────────────────────────────────┐
│ ● May 03 · Salutem                   │
│ John D. (Repeat)              [HIGH] │
│ T03 · Late delivery     [REPLACEMENT]│
│ #114-9924... · respond by 3h         │
└──────────────────────────────────────┘
```

#### C. Shipping Labels plan
```
┌──────────────────────────────────────┐
│ ☑ #11324523-12  [SS] Salutem [Frozen]│
│ Wagyu beef tenderloin 8oz · 4.2lb    │
│ to TX · by Mon 6PM                   │
│ [UPS] Ground Saver  $12.45  [Ready]  │
└──────────────────────────────────────┘
```

Точные карточки нарисую в промпте для Claude Code на этапе адаптации.

### 3.4. CustomerHubTabs (плашки-табы)

```tsx
<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
  {/* 4 плашки с иконкой + title + meta + count */}
</div>
```

**На мобиле:** 1 колонка, 4 плашки по ~64px = 256px вертикали только на навигацию.

**Решение:**
- Вариант A (минимум): оставить как есть — функционально работает, просто длинно.
- Вариант B (лучше): **на мобиле сделать горизонтальный скролл-ряд таб-чипов** (без иконок и meta — только title + count). По типу того, как сделаны табы в Twitter/X.
```tsx
<div className="flex gap-2 overflow-x-auto no-scrollbar md:hidden">
  {tabs.map(t => <TabChip key={t.key} ... />)}
</div>
<div className="hidden md:grid md:grid-cols-2 lg:grid-cols-4 gap-2">
  {/* плашки как сейчас */}
</div>
```

### 3.5. Modal-диалоги (Dialog, Sheet)

#### `Dialog` (shadcn) — используется в Shipping `tagModal` и `skuModal`
Дефолтное поведение shadcn Dialog: на мобиле занимает почти весь экран (есть max-width только на ≥sm). **Это OK как контейнер.**

**Проблема внутри Shipping `skuModal`:**
```tsx
<div className="grid grid-cols-4 gap-3">
  {/* Weight, Length, Width, Height */}
</div>
```
На мобиле 4 input'а в одну строку = шириной 60–70px каждый. Невозможно ввести цифры.

**Решение:** `<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">` — 2x2 на мобиле, 1x4 на десктопе.

Также:
```tsx
<div className="grid grid-cols-2 gap-3 text-sm">
  {/* SKU, Product (disabled inputs) */}
</div>
```
На мобиле OK (по 50% ширины), но Product может обрезаться. Лучше: `grid-cols-1 sm:grid-cols-2`.

#### `Sheet` (shadcn) — используется (или будет) для drawer-меню на мобиле
По умолчанию Sheet рендерится на 80% ширины экрана со стороны (`side="left"` для нашего sidebar). Это ровно то, что нужно для мобильного nav.

### 3.6. Sticky action bar (Shipping) — нижняя панель

```tsx
<div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-rule bg-surface/95 px-4 py-3 backdrop-blur-md">
  {/* selected count + Clear + Buy primary + (kbd hint) */}
</div>
```

**Текущее состояние:** Уже OK для мобилы! `flex` корректно сжимается, `kbd` подсказка скрывается на ≥sm. Единственная проблема — `-mx-4` рассчитан под padding страницы (если на мобиле padding изменится с 32 на 16, `-mx-4` подойдёт идеально).

**Минорный фикс:** убедиться, что `Buy selected` кнопка не схлопывается до иконки на узком экране.

### 3.7. FilterTabs (kit/FilterTabs.tsx)
```tsx
<div className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
```
`flex-wrap` корректно работает. **Уже адаптивно.** ✅

Минор: `rightSlot` (с текстом типа "120 rows · last 30d") на мобиле может переноситься на новую строку — это нормально, но может смотреться неаккуратно. Можно `<span className="hidden sm:inline">` для части текста.

### 3.8. Touch targets (минимум 44×44px по Apple HIG / 48×48 по Material)

Текущие проблемные места:
- `NavLink` в Sidebar: `px-2.5 py-1.5` → высота ~28px. На мобиле в drawer **нужно** увеличить до `px-3 py-2.5` минимум.
- `Btn` size="sm": ~26px высоты. Только для desktop, на мобиле использовать size="default".
- Чекбоксы в Shipping plan: `h-3.5 w-3.5` (14px) — слишком мелко для пальца. Нужно либо обернуть в большую clickable-зону, либо `h-5 w-5` на мобиле (`h-3.5 w-3.5 md:h-3.5`).
- Bell-кнопка в Header: `h-8 w-8` (32px) — на грани. Лучше `h-9 w-9 md:h-8 md:w-8`.

---

## 4. Проблемы по конкретным страницам

### 4.1. `/` Dashboard (`src/app/page.tsx`)
- ✅ KPI grid правильно responsive (sm:2 → lg:4).
- ✅ Главный grid `lg:grid-cols-[1fr_320px]` корректно сворачивается в 1 колонку.
- ❌ Таблица "Awaiting fulfilment" — нужно добавить mobile-cards альтернативу.
- ❌ "Customer queue" блок справа — на мобиле уедет вниз, **это нормально**, но `grid-cols-2 gap-3` внутри shipping-progress блока надо проверить.
- ⚠️ PageHead с двумя actions ("Refresh", "Generate plan") — норм, но на узких 360px может схлопнуться. Кнопки нормального размера.

### 4.2. `/customer-hub` Customer Hub (`src/app/customer-hub/page.tsx`)
**Самая сложная страница.** Содержит:
- KPI карточки (HubStatsCards)
- LossesDashboard (свернутый по умолчанию)
- 4 плашки-таба (CustomerHubTabs)
- Под выбранным табом — таблица с детализацией

**Проблемы:**
- ❌ PageHead имеет 6 actions подряд → переполнение.
- ❌ MessagesTab имеет 9-колоночную таблицу.
- ⚠️ MessageDetail — отдельная панель, открывается под таблицей. На десктопе хорошо, на мобиле станет "длинная страница" — приемлемо, но если хочется уровня "родного приложения", лучше вынести в Sheet с правой стороны.

### 4.3. `/shipping` Shipping Labels (`src/app/shipping/page.tsx`)
- ❌ Custom CSS grid с фиксированными колонками — НЕ помещается на мобиле. Нужны cards.
- ❌ Top-bar с фильтрами (Select all + Frozen + Dry + Deselect + count) → плохо переносится.
- ❌ skuModal: grid-cols-4 для размеров.
- ⚠️ Sticky bottom action bar — почти OK.

### 4.4. `/adjustments` Adjustments (`src/app/adjustments/page.tsx`)
- ✅ KPI grid OK.
- ⚠️ Inline notice с SP-API delay — текст длинный, на мобиле будет 5–6 строк. OK.
- ❌ AdjustmentsTable — нужно посмотреть отдельно (внутренний компонент).
- ❌ SkuIssuesPanel — внутренний компонент.

### 4.5. `/procurement` Procurement (`src/app/procurement/page.tsx`) — УЖЕ MOBILE-READY ✅

**Главное открытие аудита.** Эта страница изначально спроектирована под мобильный сценарий (Vladimir в магазине с телефоном).

**Что уже сделано правильно:**
- Контейнер `mx-auto w-full max-w-[820px] px-4 sm:px-6` — узкий, заточенный под телефон.
- **Никаких таблиц** — `ProcurementCard` + `ProcurementList` с группировкой по заказу.
- Фото 80×80px (`PhotoLightbox` fullscreen с pinch-zoom — `touch-action` не залочен, iPhone friendly).
- `PartialInput` stepper: кнопки 36×36px (`h-9 w-9`) — отличные touch-targets.
- Главные actions "Купил всё" / "Купил частично" — size=sm но визуально приемлемые.
- `StorePriorityPopup` — модалка с `max-w-[440px]`, в коде явно: *“Reorder via ↑/↓ buttons (mobile-friendlier than drag handles)”*.
- `Optimistic update` + `revert on error` — на мобильном интернете это критично — и уже сделано.
- Русский интерфейс для реального пользователя в магазине.

**Минорные шероховатости (опциональные улучшения, не блокирующие):**
- Кнопка копирования `h-7 w-7` (28px) — на грани Apple HIG (44px). Но это вторичная функция — допустимо.
- В `StorePriorityPopup` кнопки ↑/↓/удалить — `h-7 w-7`. Аналогично.
- Search input `py-2` — высота около 36px. На мобиле идеально 44px.
- Ордер-хедер chips (`flex flex-wrap`) на узком экране может переноситься в 4–5 строк — это OK, но визуально можно прибрать.

**Главный блокер для Procurement — НЕ в самой странице**, а в App Shell. Когда Vladimir открывает `/procurement` на телефоне, sidebar 236px всё равно рендерится. Поэтому **Phase 1 промпт = в основном работа над App Shell** + косметика в Procurement.

### 4.6. `/account-health` Account Health (`src/app/account-health/page.tsx`)

**Общий layout — в порядке** ✅
- KPI grid `lg:grid-cols-[1.3fr_1fr_1fr]` → на мобиле 1 колонка.
- StoreCard grid `grid-cols-1 lg:grid-cols-2` → на мобиле 1 колонка автоматически.
- Hero green card — ок, подписи не переполняются.
- WalmartPerformancePanel — `grid-cols-2 lg:grid-cols-4` — на мобиле 2 колонки (ок, но плотно).

**Проблемы:**
- ⚠️ **MetricRow внутри StoreCard** — `flex items-center justify-between` с label слева и набором value/badge/limit справа. На 380px будет тесно: "Order Defect Rate" + "0.5% (12/3000) ✓ ≤0.5%" не помещается. Решение: либо скрывать limit/numerator на мобиле, либо `flex-col sm:flex-row`.
- ⚠️ **PageHead имеет 3 actions** ("Refresh all", "90-day view", "Action plan"). Две последние на мобиле разбивают layout — решится общим фиксом PageHead.
- ⚠️ **shadcn `<Card className="border-2">`** — альтернативный вариант Panel/PanelBody. Работает ок на мобиле.

**Оценка:** страница ок, требует точечного фикса MetricRow (~10–15 минут Claude Code). Таблиц нет — это плюс.

### 4.7. `/frozen-analytics` Frozen Analytics (`src/app/frozen-analytics/page.tsx`)

**Общий layout — в порядке** ✅
- KPI grid `sm:grid-cols-2 lg:grid-cols-4` — ок.
- FilterTabs с 3 табами — только label+count, не жирные плашки как в Customer Hub.
- WalmartBaselineCard сверху — не читал детально.

**Проблемы (внутри табов):**
- ❌ **IncidentsTable** — использует shadcn `<Table>` (подтверждено). 12+ полей (orderId, sku, productName, carrier, service, shipDate, promisedEdd, actualDelivery, daysInTransit, daysLate, origin/dest temp, outcome). Нужны mobile-cards.
- ❌ **SkuRiskTable** — по паттерну тоже таблица. Нужны cards.
- ⚠️ **PatternsDashboard** — по имени графики. Отложен в Phase 2 без детального аудита графиков.
- ⚠️ **TransitTimeline + WeatherBlock** — в expand-row инцидента. На мобиле выглядят под карточкой, приемлемый режим.

**Оценка:** паттерн как у Adjustments/Customer Hub: 2 таблицы под mobile-cards + проверка графиков.

### 4.8. `/claims/atoz` Claims (`src/app/claims/atoz/page.tsx`)

**Общий layout:**
- KPI grid `grid-cols-2 lg:grid-cols-4` — на мобиле 2 колонки ✅
- ⚠️ **Нет PageHead** — страница начинается сразу с KPI-карточек, без заголовка и actions. Отличается от всех других страниц — явный недодел.

**Блокеры:**
- ❌ **AtozTable** — 8-колоночная таблица с expand-rows (expand+urgent+type+orderId+amount+strategy+deadline+status). Нужны mobile-cards.
- Expand-row внутри имеет `grid-cols-2 gap-2` — на мобиле желательно `grid-cols-1 sm:grid-cols-2`.

### 4.9. `/feedback` Feedback (`src/app/feedback/page.tsx`)

**Общий layout:**
- KPI grid `grid-cols-2 lg:grid-cols-4` — ок ✅
- ⚠️ **Нет PageHead** — такая же проблема как в Claims.
- ✅ **shadcn Tabs** для Seller Feedback / Product Reviews — работают на мобиле.
- ✅ **Product Reviews уже в cards-формате** (`<div className="rounded-lg border p-3">` с 5 звёздами, title, body) — это хорошо.

**Блокеры:**
- ❌ **FeedbackTable** (Seller Feedback) — 7-колоночная таблица (expand+rating+date+order+comment+ai+status). Нужны mobile-cards.
- `<select>` фильтры в `flex-wrap` — ок на мобиле.

### 4.10. `/settings` Settings (`src/app/settings/page.tsx`) — САМАЯ БОЛЬШАЯ СТРАНИЦА

~1000 строк, 6 секций, сложная структура. В основе — stack из Card-блоков, это хорошо для мобилы.

**Секции:**
- Section 0: User permissions (крохотная, ок)
- Section 1: Connected Accounts (Gmail + SP-API panels)
- Section 2: AI Decision Engine (provider selection)
- Section 3: External Services (API connections list)
- Section 4: App Configuration (Loss settings + Notifications + External API)
- Section 5: Data (Sync Panel + SKU Database)

**Блокеры:**
- ❌ **SKU Database table** (9 колонок: SKU, Product, Marketplace, Category, L, W, H, Weight, FedEx 1R) — на мобиле не помещается. Нужны mobile-cards или horizontal scroll. **Самая сложная таблица проекта.**
- ⚠️ **GmailAccountsPanel и SpApiStoresPanel rows** — `flex items-center justify-between gap-4` с info слева и actions справа. На 380px экране будет тесно — нужен `flex-col sm:flex-row`.
- ⚠️ **CardHeader в SyncPanel и SKU Database** — `flex flex-row items-center justify-between` с title + actions. Иногда ломается на мобиле.
- ⚠️ **AiProvidersPanel** имеет `<select>` с `w-52` (208px) — на 380px экране занимает почти всю ширину. `flex justify-between` label+select будет тесно.
- ⚠️ **Свой заголовок вместо PageHead** — непоследовательность с другими страницами.

**Оценка:** в целом страница живая, большинство ломок исправятся точечно (`flex-col sm:flex-row`, скрыть второстепенные детали). Главная работа — SKU Database table.

### 4.11. `/login` и `/invite/[token]` — 🚨 НАЙДЕННЫЙ БАГ (отдельный от mobile)

**Обе страницы используют СИНЮЮ Tailwind-палитру вместо Salutem Design System.** Это явный баг/legacy:
```tsx
// login/page.tsx
<div className="... bg-gradient-to-br from-blue-50 to-indigo-100">
  <div className="... bg-white ... shadow-lg">
    ...
    <input className="... border-gray-300 focus:border-blue-500 focus:ring-blue-500" />
    <button className="bg-blue-600 hover:bg-blue-700 text-white">Sign In</button>
```
Это **НЕ** `--green`, `--ink`, `--green-cream`. Легаси либо недоперенос на Salutem. **Рекомендация:** отдельный промпт на ребрендинг login/invite на Salutem (~30 минут работы Claude Code).

**Mobile-адаптивность обеих страниц — в порядке** ✅:
- `min-h-screen flex items-center justify-center` — выровнено по центру.
- `max-w-sm` (384px) — хорошо для телефона.
- Inputs full-width.
- `LoginLayout` не использует AppShell (sidebar/header выключены) — это правильно работает через STANDALONE_PREFIXES в AppShell.

**Оценка:** mobile-адаптивность не требует работы. Но **найден баг** — не в дизайн-системе.

### 4.12. Субкомпоненты Customer Hub и Adjustments (чанк 5 — финал)

#### Adjustments
- ❌ **AdjustmentsTable** — 8-колоночная shadcn `<Table>` с expand-rows (expand+date+channel+orderId+sku+type+amount+status). Expand-row внутри `grid-cols-2 gap-3`. Нужны mobile-cards.
- ❌ **SkuIssuesPanel** — 7-колоночная таблица (sku+product+corrections+totalLoss+type+suggestedWeight+status), без expand. Нужны mobile-cards.

#### Customer Hub
- ✅ **HubStatsCards** — использует KpiCard в `sm:grid-cols-2 lg:grid-cols-4`. Полностью responsive.
- ✅ **LossesDashboard** — collapsible Card. `flex justify-between` в хедере выровненный, но плотно на мобиле (иконка+титул+сумма слева + сохранённое+chevron справа). Работает OK.
- ❌ **AtozTab** — shadcn Table 8 колонок (status+store+orderId+carrier+amount+deadline+whoPaid+strategy). Проверен детально. Сверху 5-колоночный summary `grid-cols-2 md:grid-cols-5` — на мобиле 2 колонки ✅. Диалог добавления claim'а имеет `grid-cols-2 gap-2` (Amount, Deadline) — на мобиле приемлемо (по 50%).
- ❌ **ChargebacksTab** — клон AtozTab (подтверждается импортами в page и общей архитектуре). Такие же фиксы.
- ❌ **FeedbackTab** — аналогично: shadcn Table + expand. Применить mobile-cards как в FeedbackTable.
- ⚠️ **MessageDetail** (самый сложный, ~700 строк) — прочитан полностью:
  - ✅ Bilingual блоки (Customer Message, Suggested Response) уже используют `grid-cols-1 md:grid-cols-2` — на мобиле автоматически 1 колонка.
  - ⚠️ Action buttons row (Copy / Edit / Re-analyze / Rewrite ▾ / Responded in SC / Send) — 6+ кнопок в `flex gap-2 mt-2` без wrap. На мобиле переполняется. Нужно `flex-wrap` или horizontal scroll или overflow-menu.
  - ⚠️ AI Analysis блок `grid-cols-2 gap-2 text-xs` (Type, Risk, Action, Who pays) — на 380px может быть тесно для баджей. Ок, но на грани.
  - ⚠️ Shipping & Tracking блок тоже `grid-cols-2 gap-x-4 gap-y-1` — 9 ячеек (carrier, service, tracking, status, ship date, etc.). Сжмёт на мобиле.
  - ⚠️ Save to KB Dialog — форма с textareas и selects, сложная. `max-w-lg` Dialog на мобиле = full width — OK.
- ❌ **AtozDetail / FeedbackDetail** — не читал, но паттерн ясен (вариация MessageDetail). Требуют те же фиксы: action buttons row, grid-cols-2 в detail-секциях.
- ❌ **WalmartCaseModal** — не читал. Название = Dialog/Modal. При фиксе PageHead actions будет выведен в overflow.

#### CS (легаси)
- 🚨 **StoreTabs.tsx** (`/components/cs/`) — **второй найденный баг на синей палитре** (кроме Login/Invite). Использует `text-blue-600 bg-blue-50/50 border-blue-600`. Mobile-ок (`overflow-x-auto`). Добавить в промпт ребрендинга.

### 4.13. Phase 2 disabled страницы
- `/listings`, `/suppliers` (видели), и вероятно `/analytics`, `/promotions` — это простые `<ComingSoon>` плейсхолдеры. Не блокеры. ComingSoon компонент не читал, но скорее всего работает на мобиле.
- `/integrations` — реальная страница с списком сервисов (`flex justify-between` rows). Ок на мобиле.

**Принцип:** общие правила (sidebar→drawer, table→cards, header→hamburger, padding→16px) применить **глобально**, потом точечно проверить каждую страницу.

---

## 5. Стратегия адаптации

### 5.1. Брейкпоинты
- **Mobile:** < 768px (`md:`). Сюда попадают все смартфоны и небольшие планшеты в портретной ориентации.
- **Tablet:** 768–1024px (`md:` — `lg:`). iPad портрет, мини-ноутбуки. Sidebar уже виден, table тоже работают.
- **Desktop:** ≥ 1024px (`lg:`). Полный layout как сейчас.

**Главная граница для нашей адаптации = `md` (768px).** Всё, что < md, считаем "мобилой" и применяем drawer/cards.

### 5.2. Порядок работы (для Claude Code в промпте)

**Этап 1: фундамент (1–2 часа)**
1. Создать `useIsMobile` хук в `src/lib/use-is-mobile.ts`.
2. Создать context `MobileNavContext` для open-state бокового меню.
3. Разделить `Sidebar.tsx` → `SidebarContent.tsx` (общая начинка) + `Sidebar.tsx` (desktop-only враппер) + `MobileNav.tsx` (Sheet-обёртка).
4. Обновить `AppShell.tsx`: подключить контекст, оба варианта sidebar.
5. Обновить `Header.tsx`: добавить гамбургер, скрыть search на мобиле, иконку search вместо неё.
6. Обновить padding: `var(--content-padding)` → конструкция через Tailwind `p-4 pb-6 md:p-7 md:pt-7 md:pb-10` или `clamp()` в CSS.

**Этап 2: PageHead (30 мин)**
7. Сделать PageHead actions горизонтально-прокручиваемыми на мобиле (`overflow-x-auto no-scrollbar md:overflow-visible`).

**Этап 3: таблицы → карточки (3–4 часа)**
8. Dashboard "Awaiting fulfilment": cards + hidden md:block.
9. Customer Hub Messages: cards + hidden md:block.
10. Shipping Labels plan: cards + hidden md:block (это самое сложное — там кастомный grid).
11. Adjustments table: cards + hidden md:block.
12. (опционально) ввести общий `<MobileCardList items={...} renderCard={...} />`, если не хочется DRY-нарушения.

**Этап 4: точечные модалки и формы (1 час)**
13. Shipping skuModal: `grid-cols-2 sm:grid-cols-4`.
14. Прочие диалоги: проверка по списку.

**Этап 5: тестирование и фиксы (0.5 дня)**
15. Прогнать в Chrome DevTools на 375×667 (iPhone SE/8), 390×844 (iPhone 12+), 768×1024 (iPad).
16. Зафиксить визуальные баги.

### 5.3. Что НЕ трогаем
- ❌ Salutem Design System — цвета, типографика, радиусы, шрифты.
- ❌ Бизнес-логику страниц, API-интеграции, Prisma схему.
- ❌ Tailwind config (он `@theme inline` в CSS — там менять нечего).
- ❌ Базовые shadcn/ui компоненты (`button.tsx`, `dialog.tsx`, etc.).

Адаптация — это **только layout, responsive-классы и условный рендер**. Дизайн остаётся тот же, просто умеет на узких экранах.

---

## 6. Список файлов для изменений

### 6.1. Новые файлы (создать)
- `src/lib/use-is-mobile.ts` — хук с window.matchMedia.
- `src/lib/mobile-nav-context.tsx` — context для open-state мобильного nav.
- `src/components/layout/SidebarContent.tsx` — выделенная начинка sidebar.
- `src/components/layout/MobileNav.tsx` — обёртка над Sheet для мобильного drawer.

### 6.2. Файлы для изменений
- `src/app/layout.tsx` — добавить MobileNavContext provider.
- `src/components/layout/AppShell.tsx` — переключение sidebar/mobile-nav, padding.
- `src/components/layout/Sidebar.tsx` — `hidden md:flex` + использовать `SidebarContent`.
- `src/components/layout/Header.tsx` — гамбургер, иконка-search вместо bar.
- `src/components/kit/PageHead.tsx` — overflow-x для actions.
- `src/app/page.tsx` — mobile-cards для таблицы.
- `src/app/customer-hub/page.tsx` (если нужно) — обёртки над PageHead actions.
- `src/components/customer-hub/MessagesTab.tsx` — mobile-cards.
- `src/components/customer-hub/CustomerHubTabs.tsx` — горизонтальный скролл табов на мобиле (опционально).
- `src/app/adjustments/page.tsx` — нет, основное в `AdjustmentsTable`.
- `src/components/adjustments/AdjustmentsTable.tsx` — mobile-cards.
- `src/components/adjustments/SkuIssuesPanel.tsx` — проверить.
- `src/app/shipping/page.tsx` — mobile-cards, скорректировать skuModal grid.

### 6.3. Файлы под вопросом (проверить отдельно)
- `src/components/customer-hub/MessageDetail.tsx`, `AtozTab.tsx`, `ChargebacksTab.tsx`, `FeedbackTab.tsx`, `LossesDashboard.tsx`, `HubStatsCards.tsx`, `WalmartCaseModal.tsx`.
- Все страницы Phase 1: `account-health/`, `frozen-analytics/`, `procurement/`, `claims/`, `feedback/`, `settings/`.

---

## 7. Что НЕ входит в Phase 1 mobile-адаптации

Эти улучшения логично сделать **позже**, отдельной задачей:

- **PWA** (manifest.json, service worker, offline support, install banner).
- **Native-like жесты** (swipe для удаления, pull-to-refresh).
- **Push-уведомления** на мобильное устройство.
- **Bottom navigation** в стиле iOS/Android (вместо drawer слева). Если в дальнейшем окажется, что drawer неудобен — пересмотреть.
- **Адаптивные графики** в Frozen Analytics, если там Recharts/d3 — на мобиле они часто требуют отдельного подхода.

---

## 8. Вопросы к Vladimir

Перед написанием промпта для Claude Code хочу подтвердить:

1. **Нужна ли мобильная адаптация ВСЕХ страниц** или только основных (Dashboard, Customer Hub, Shipping, Adjustments)?
2. **MessageDetail** в Customer Hub — на мобиле оставить как inline-блок под таблицей или сделать "fullscreen" Sheet справа?
3. **Стратегия табов в Customer Hub** на мобиле — оставить плашки в 1 колонку (long scroll) или горизонтальный chip-strip?
4. **Тестирование** — будешь смотреть на реальном телефоне или достаточно Chrome DevTools мобильного режима?
5. **Объединить с Design System миграцией** или отдельный заход? Если делаем сейчас, в текущем коде — чисто адаптация. Если сначала миграция дизайн-системы — то адаптацию делаем после.

---

## 9. История

- 2026-05-03 (финал): Чанк 5 — Субкомпоненты Customer Hub + Adjustments + Phase 2 disabled. **MessageDetail (~700 строк) прочитан полностью** — bilingual секции уже responsive ✅, но action buttons row переполняется. **Найден 3-й баг:** `cs/StoreTabs.tsx` тоже на синей палитре (как Login/Invite). Phase 2 disabled — простые ComingSoon плейсхолдеры, не блокеры. **Phase 0 АУДИТ ЗАВЕРШЁН**.
- 2026-05-03 (ночь): Чанк 4 — Claims + Feedback + Settings + Login/Invite. **Найден баг:** Login и Invite на синей Tailwind-палитре вместо Salutem Design System. Найдены 4 новые таблицы (AtozTable, FeedbackTable, SKU Database в Settings) без mobile-вариантов. Нет PageHead в Claims, Feedback, Settings.
- 2026-05-03 (поздно вечер): Чанк 3 — Account Health + Frozen Analytics. Находки: общий layout ок, блокеры внутри субкомпонентов (MetricRow в Account Health, IncidentsTable + SkuRiskTable в Frozen).
- 2026-05-03 (вечер): **Procurement аудирован детально** (page.tsx + 4 субкомпонента). Вывод: страница уже mobile-ready, блокер только в App Shell.
- 2026-05-03 (день): Аудит создан Claude через Filesystem MCP. Прочитано 12 ключевых файлов проекта.
