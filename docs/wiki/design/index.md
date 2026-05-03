# 🎨 Design System — Salutem Control Center

Раздел описывает визуальную систему SS Control Center и каталог HTML‑mockup'ов, которые служат источником правды для реализации UI в Next.js.

Физическое расположение файлов: `/design/` в корне проекта.

---

## 📐 Salutem Design System v1.0

Философия: сдержанный офисный инструмент для ежедневной работы, а не ярморочный дашборд. Forest green + matte silver + warm cream. Никакого чёрного текста, никакого красного для отрицательных чисел в финансах, никаких множественных теней.

### Палитра (CSS variables)

**Нейтральные (cool-leaning, silver-adjacent):**
- `--bg: #F4F3EF` — мягкий off-white фон всего приложения
- `--bg-elev: #EDECE7` — приподнятые нейтральные панели
- `--surface: #FFFFFF` — карточки
- `--surface-tint: #F8F7F3` — subtle tint для зон внутри карточки

**Текст (с лёгким зеленоватым оттенком — matches brand):**
- `--ink: #15201B` — основной (вместо чёрного)
- `--ink-2: #4E554F` — вторичный
- `--ink-3: #7A807B` — приглушённый
- `--ink-4: #AEB2AD` — самый светлый

**Линии:**
- `--rule: rgba(21,32,27,0.08)` — базовый хейрлайн
- `--rule-strong: rgba(21,32,27,0.16)` — сильнее, для кнопок

**Salutem green (primary):**
- `--green: #1F4D3F` — forest, основной акцент
- `--green-deep: #14352B` — pressed state
- `--green-mid: #3A6B5D` — промежуточный
- `--green-soft: #E6EEE9` — tint backgrounds
- `--green-soft2: #CDDDD5` — чуть насыщенней
- `--green-ink: #12362C` — текст на green-soft
- `--green-cream: #F0E8D0` — ВАЖНО: cream для текста на зелёном фоне (warm-off-white, читаемый, не белый)

**Salutem silver (accent):**
- `--silver: #B5B8B5` — matte silver (плоский, не металлический)
- `--silver-dark: #8E918E`
- `--silver-tint: #EAEBE9` — silver-tinted fills
- `--silver-line: #D2D4D1` — crisp silver divider

**Семантические:**
- `--frozen: #2E6FA8` + `--frozen-tint: #E5EEF6` — замороженные продукты
- `--dry: #8B6B1C` + `--dry-tint: #F3EDDD` — сухие продукты
- `--warn: #A05B20` + `--warn-tint: #F5E9DC` — предупреждения (warm amber, не жёлтый)
- `--danger: #9B2C2C` + `--danger-tint: #F5E1E1` — только для реальных ошибок
- `--info: #2E6FA8` + `--info-tint: #E5EEF6` — информационные алерты

### Типографика

- Sans: **Inter Tight** (400, 500, 600, 700)
- Mono: **JetBrains Mono** (400, 500) — для ID, timestamps, кодов, метрик
- Base size: 13.5px, line-height 1.5
- Letter-spacing: −0.005em на body, −0.02em на заголовках
- `font-variant-numeric: tabular-nums` на всех числах

### Радиусы

- `--radius-sm: 6px` — кнопки-пиллы, чипы
- `--radius: 10px` — инпуты, small cards
- `--radius-lg: 14px` — основные карточки, dashboard surfaces

### Сетка приложения

```
┌──────────┬──────────────────────────────────────┐
│ Sidebar  │ Topbar (56px)                        │
│ 236px    ├──────────────────────────────────────┤
│          │ Content (max 1400–1500px, padding    │
│          │ 28px 32px 40px)                      │
└──────────┴──────────────────────────────────────┘
```

---

## 🧩 Общие компоненты

Используются одинаково во всех 7 mockup'ах:

- **Brand block** — 32×32 зелёный квадратик с буквой S + "Salutem / CONTROL · V1.4" (mono 10px)
- **Workspace switcher** — "All stores / 5" с зелёным дотом
- **Nav sections** — mono 10px uppercase labels: Operations / Phase 2
- **Nav items** — active state в green-soft, disabled — opacity 0.52 с "Soon" badge
- **Helper card** — внизу sidebar, зелёный фон + cream текст + декоративные круги (pseudo-elements), контекстный CTA
- **Search** — 340px, `⌘K` kbd hint
- **Live-pill** — "5 stores live" с пульсирующим дотом (`animation: pulse 2s ease-in-out infinite`)
- **Store avatars** — SS (green/cream), AZ (soft2/ink), SI (silver-dark/bg), WM (silver-tint + inset border), RD (green-mid/cream), PV (bg-elev/ink-2)
- **Type tags** — Frozen (`--frozen-tint` + дот) / Dry (`--dry-tint` + дот)
- **KPI card** — 14px радиус, label + 26×26 иконка + 30px tabular число + chips или progress
- **Hero card (green)** — green background, cream text, 2 декоративных круга через `::before` / `::after`, `--green-cream` divider
- **Risk pills** — LOW (green-soft), MEDIUM (silver-tint), HIGH (warn-tint), CRITICAL (danger-tint) с 6px дот-префиксом
- **Sync-chip** — mono 10.5px, "Last sync Xm ago" в green-soft

---

## 📁 Каталог mockup'ов

Файлы в `/design/`. Каждый — полноценный, автономный HTML со встроенным CSS (≈1100 строк), открывается двойным кликом.

### Reference / система

- **`DESIGN_TOKENS.md`** — Single source of truth для палитры, типографики, радиусов. Все 7 файлов ниже используют точно эти же CSS variables.
- **`README.md`** — быстрый каталог mockup'ов + статус реализации.

### Operations (Phase 1)

- **`dashboard_salutem.html`** — главная страница. KPI row (Orders today, Ship today, Labels purchased, Cases open), сегодняшние заказы (table), Customer queue, Shipping progress card (hero green), action row внизу. ⇔ [dashboard.md](../dashboard.md)

- **`account_health_salutem.html`** — мониторинг здоровья 5 Amazon аккаунтов + Walmart. Overall health hero + Worst ODR / LSR-VTR snapshot, alerts band (SP-API + Gmail listing-compliance), per-store snapshots grid (ODR/LSR/VTR бары с limit-маркерами), ODR trend SVG chart (5 цветных линий + 1% danger threshold), event stream, policy thresholds reference table. ⇔ [account-health.md](../account-health.md)

- **`shipping_labels_salutem.html`** — план + покупка labels. Hold alert (missing SKU dims), KPI row, filter tabs (All / Ready / Bought / On hold / Frozen / Dry), shipping table с 8 колонками (Order / Store / Product / Type / Weight / Dest / Service / Status), sticky action bar внизу с Total cost + Buy selected. ⇔ [shipping-labels.md](../shipping-labels.md)

- **`customer_hub_salutem_v2.html`** — AI-driven customer service. 4 таба (Messages / A-to-Z / Chargebacks / Feedback), messages list + detail panel с Decision Engine (5-слойная сетка, economic ladder 5 rungs: clarification → redirect Amazon → replacement → partial refund → full refund), Walmart modal с screenshot grid. Следует [CUSTOMER_HUB_ALGORITHM_v2.1.md](../../CUSTOMER_HUB_ALGORITHM_v2.1.md). ⇔ [customer-hub.md](../customer-hub.md)

- **`frozen_analytics_salutem.html`** — инциденты с замороженными + SKU risk analysis + patterns dashboard. Tampa origin temp + destination temp через Open-Meteo, transit timeline, risk score 0–100. 3 секции: Incidents Log (таблица с 🔴🟡🟢 outcome), SKU Risk Analysis (bar visualization), Patterns Dashboard (high-risk combinations, thaw rate by transit days / Tampa temp). ⇔ [frozen-analytics.md](../frozen-analytics.md)

- **`adjustments_salutem.html`** — финансовые корректировки из SP-API Finances v2024-06-19. Sync notice (48h delay), KPI row (Credits / Debits / Net / Pending), filter tabs (по типу), tx table с source-chip SP-API/CSV, linked order, pagination. ⇔ [adjustments-monitor.md](../adjustments-monitor.md)

### Settings

- **`settings_salutem.html`** — секция integrations с health summary, 6 тематических групп (Marketplace APIs / Shipping & Inventory / Email / AI providers / Notifications / Cloud storage). Каждая интеграция — int-card с logo + status chip + KV-grid + actions. Amazon SP-API multi-store card с 5 conn-row'ами (2 connected, 3 pending). ⇔ связан со всеми `*-api.md` статьями wiki.

### Deprecated

- **`customer_hub_v1_DEPRECATED.html`** — старая версия v1 до алгоритма v2.1. Оставлен как архив, не актуален.

---

## 🔀 Связь с Next.js реализацией

Эти mockup'ы — **источник визуальной правды**, но не реализация.

При переносе в Next.js 14 + Tailwind + shadcn/ui:

1. CSS variables из `DESIGN_TOKENS.md` переносятся в `tailwind.config.ts` (под `theme.extend.colors`) и в глобальный `app/globals.css` для `@theme` токенов
2. Inter Tight и JetBrains Mono подключаются через `next/font/google`
3. Общие компоненты (sidebar, topbar, store-avatar, type-tag, kpi-card, hero-card, risk-pill, sync-chip) делаются reusable-компонентами в `components/ui/` и `components/layout/`
4. Each mockup page → соответствующий route в `app/` (например, `app/customer-hub/page.tsx`)
5. shadcn/ui компоненты (`Button`, `Card`, `Table`, `Tabs`, `Dialog`) настраиваются под Salutem tokens — **никакого дефолтного shadcn look**

---

## ✅ Что проверять при добавлении нового mockup'а

Перед добавлением нового файла в `/design/`:

- [ ] CSS variables копируются из `DESIGN_TOKENS.md` без изменений
- [ ] Используется тот же sidebar-шаблон: Operations (Dashboard, Account health, Shipping labels, Customer hub, Frozen analytics, Adjustments) → Phase 2 (Product listings, Sales analytics — disabled) → Settings (внизу) → helper card
- [ ] Нет чёрного текста (`--ink` вместо `#000`)
- [ ] На зелёном фоне текст cream (`--green-cream`), не white
- [ ] Отрицательные финансовые числа в `--ink-2`, не красные
- [ ] Inter Tight + JetBrains Mono, 13.5px base
- [ ] Все числа — `font-variant-numeric: tabular-nums`
- [ ] Топбар 56px, контент max 1400–1500px
- [ ] Добавлен в `/design/README.md` + запись в `wiki/design/index.md` + обновлён `CONNECTIONS.md`

---

Последнее обновление: 2026-04-19
