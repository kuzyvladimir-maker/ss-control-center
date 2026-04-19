# Salutem Design System v1.0

Дизайн-токены для SS Control Center. Все HTML-мокапы в `/design/` используют эту палитру.

## Бренд-направление

**Atelier refined to Salutem brand** — warm minimal UI с forest green как primary action color и matte silver как accent. Спокойный, профессиональный, operator-friendly для длительной работы.

---

## Цветовые токены (CSS variables)

```css
:root {
  /* === Neutrals (cool off-white, silver-adjacent) === */
  --bg:          #F4F3EF;   /* страница, основной фон */
  --bg-elev:    #EDECE7;    /* raised панели, hover states */
  --surface:    #FFFFFF;    /* карточки, таблицы */
  --surface-tint: #F8F7F3;  /* subtle zones внутри surface */

  /* === Ink (greenish undertone — не чёрный) === */
  --ink:    #15201B;         /* основной текст */
  --ink-2:  #4E554F;         /* secondary текст */
  --ink-3:  #7A807B;         /* meta, подписи */
  --ink-4:  #AEB2AD;         /* disabled, самая светлая иконка */

  /* === Rules / hairlines === */
  --rule:        rgba(21,32,27,0.08);
  --rule-strong: rgba(21,32,27,0.16);

  /* === Salutem GREEN — primary === */
  --green:       #1F4D3F;   /* forest — primary CTA */
  --green-deep:  #14352B;   /* pressed state */
  --green-mid:   #3A6B5D;
  --green-soft:  #E6EEE9;   /* tint для фонов, statuses */
  --green-soft2: #CDDDD5;
  --green-ink:   #12362C;   /* текст на green-soft */
  --green-cream: #F0E8D0;   /* cream-текст на green (НЕ белый) */

  /* === Salutem SILVER — accent === */
  --silver:      #B5B8B5;   /* matte silver (flat, не металлический) */
  --silver-dark: #8E918E;
  --silver-tint: #EAEBE9;
  --silver-line: #D2D4D1;   /* crisp silver divider */

  /* === Semantic === */
  --frozen:      #2E6FA8;   /* cool blue для frozen */
  --frozen-tint: #E5EEF6;
  --dry:         #8B6B1C;   /* warm amber для dry */
  --dry-tint:    #F3EDDD;
  --warn:        #A05B20;
  --warn-tint:   #F5E9DC;
  --warn-strong: #8B4A18;
  --danger:      #9B2C2C;
  --danger-tint: #F5E1E1;
  --info:        #2E6FA8;
  --info-tint:   #E5EEF6;
  --purple:      #5B4A7A;
  --purple-tint: #EBE7F0;
}
```

**Важно про цвета:**
- Кнопки primary — `--green` (не Tailwind blue-600)
- Текст на зелёном — `--green-cream` (F0E8D0), НЕ белый. Белый выглядит стерильно.
- Отрицательные финансовые суммы — `--ink-2` (нейтральный тёмный), НЕ красный. Красный зарезервирован для реальных ошибок/alarms.
- Красный (--danger) используется только для настоящих проблем: chargeback lost, failed integration, deletion confirmations.

---

## Типографика

```css
--sans: 'Inter Tight', -apple-system, system-ui, sans-serif;
--mono: 'JetBrains Mono', ui-monospace, monospace;
```

- **Inter Tight** — для body, заголовков, UI-элементов
- **JetBrains Mono** — ТОЛЬКО для: IDs (order IDs, tracking numbers, API keys), числовых значений (tabular-nums), временных меток, кодов/токенов

**Size scale (13.5px base):**
- Page title: 24-26px, weight 600, letter-spacing: -0.025em
- Card title: 14.5px, weight 600
- Body: 13-13.5px
- Small/meta: 11-12px
- Micro labels (uppercase): 10-11px mono, letter-spacing: 0.1-0.14em

**Числа (KPI, суммы):**
- Font-variant-numeric: tabular-nums
- Font-feature-settings: 'tnum'
- Big numbers (KPI): 28-30px, weight 600, letter-spacing: -0.03em

---

## Радиусы и тени

```css
--radius-sm: 6px;    /* маленькие элементы, pills, chips */
--radius:    10px;   /* кнопки, dropdowns */
--radius-lg: 14px;   /* карточки */
```

Тени использую минимально — опираюсь на `--rule` (1px hairline borders) для разделения. Shadow только для modal/dropdown overlays.

---

## Layout tokens

```css
/* Sidebar */
--sidebar-width: 236px;

/* Topbar */
--topbar-height: 56px;

/* Content max-width */
--content-max: 1400-1500px;

/* Content padding */
--content-padding: 28px 32px 40px;
```

---

## Ключевые компоненты (reused across pages)

### 1. Sidebar (236px)
- Brand block сверху с 32×32 green mark + "Salutem CONTROL v1.4"
- Workspace switcher (5 stores)
- Nav sections: "OPERATIONS" / "INSIGHTS" (mono uppercase, letter-spacing 0.14em)
- Active nav item: `--green-soft` bg + `--green-ink` text
- Pills справа от item: зелёная с count (активная работа) или warn с count (attention)
- Disabled items (Phase 2): opacity 0.52 + "Soon" mono badge

### 2. Topbar (56px)
- Breadcrumb слева (Operations / Current)
- Search bar (max 300-380px) с ⌘K kbd
- Live pill "5 stores live" (green-soft с pulse dot)
- Notification icon + user chip

### 3. Page head
- Title 24-26px + sync-chip рядом ("Last sync 3m ago" green-soft mono)
- Subtitle с live meta (часы, next sync, counts)
- Page actions справа (date picker, btn-sm, btn-sm primary)

### 4. KPI cards (4-колонка)
- 14px radius-lg white surface
- Kpi-head: label + icon 26×26
- Kpi-number: 28-30px tabular-nums
- Kpi-sub или sparkline или chips
- Для особо важных KPI — subtle green gradient background

### 5. Filter bar
- White surface-card
- Tab group слева (counts в pills)
- Dropdowns справа (`Store: All (5) ↓`, `Type: All ↓`)

### 6. Tables & rows
- Grid-based rows (НЕ `<table>` для сложных структур)
- Row padding 11-13px vertical
- Hover: `--surface-tint`
- Border-bottom: `--rule`

### 7. Store avatars (узнаваемые)
```
sa-salutem → green bg, cream text       "SS"
sa-amzcom → green-soft2 bg, green-ink   "AZ"
sa-sirius → silver-dark bg, bg text     "SI"
sa-walmart → silver-tint bg with border "WM"
sa-retail → green-mid bg, cream text    "RD"
sa-personal → bg-elev bg, ink-2 text    "PV"
```

### 8. Carrier badges
```
UPS   → #4C2C0E bg, #FFB500 text (brown + yellow)
FedEx → #4D148C bg, white text
USPS  → #004B87 bg, white text
```

### 9. Type tags (Frozen/Dry)
```
Frozen → frozen-tint bg, frozen text, с • (dot prefix)
Dry    → dry-tint bg, dry text, с • (dot prefix)
```

### 10. Status chips
```
Ready      → green-soft / green-ink
Pending    → silver-tint / silver-dark
Hold       → warn-tint / warn
Exception  → warn-tint / warn-strong (bold)
Delivered  → green-soft / green-ink
```

---

## Iconography

- Lucide icons (stroke-width 1.7-1.8) — основной набор
- Inline SVG 16×16 для nav, 13×13 для inline chips, 32×32 для feature icons
- Color: наследует от parent text-color

---

## Не использовать

- ❌ Чёрный как text color (используй `--ink` с greenish undertone)
- ❌ Белый как text на green (используй `--green-cream`)
- ❌ Ярко-синий (Material blue, Tailwind blue-500) для кнопок — это не наш зелёный
- ❌ Красный для отрицательных финансовых значений (нейтральный ink-2)
- ❌ Multiple shadows / gradients — максимум subtle gradient на 1-2 feature cards
- ❌ Emoji в интерфейсе (кроме sidebar nav icons)

---

## Состояния interaction

- Hover на card: `border-color: var(--silver-line)` (a subtle shift, не тень)
- Hover на nav/table row: `background: var(--bg-elev)` или `--surface-tint`
- Button hover: `surface-tint` bg + `silver-dark` border
- Primary button hover: `--green-deep` bg

---

## Анимации

Минимум. Только:
- `transition: background 0.15s, border-color 0.15s, color 0.15s`
- Live dot pulse для real-time indicators: `@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`

Никаких entrance animations, slide-in, fade-in. UI операторский — он должен быть **instant**.
